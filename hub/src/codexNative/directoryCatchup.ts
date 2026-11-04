import { record, text, type NativeRecord } from './transport'
import type { NativeRegistry } from './registry'

export type TrackedDirectorySnapshot = {
    threadIds: string[]
    projectIds: string[]
    versions: Record<string, number>
}
type DirectoryRead = { threads?: NativeRecord[]; projects?: NativeRecord[] }
export type DirectoryCatchupAdapter = {
    snapshot(): Promise<TrackedDirectorySnapshot>
    readThread(id: string, signal: AbortSignal): Promise<NativeRecord>
    readProject(id: string, signal: AbortSignal): Promise<NativeRecord>
    apply(values: DirectoryRead, versions: Record<string, number>): Promise<void>
}
export type DirectoryCatchupResult = { complete: boolean; checked: number; failed: number }

/** One metadata pass per endpoint connection gap, never an all-thread catalog scan. */
export async function reconcileTrackedDirectory(adapter: DirectoryCatchupAdapter, signal: AbortSignal, initialSnapshot?: TrackedDirectorySnapshot): Promise<DirectoryCatchupResult> {
    const result: DirectoryCatchupResult = { complete: false, checked: 0, failed: 0 }
    if (signal.aborted) return result
    const snapshot = initialSnapshot ?? await adapter.snapshot()
    if (signal.aborted) return result
    const knownProjects = new Set(snapshot.projectIds)
    const jobs = [
        ...[...knownProjects].map(id => ({ id, kind: 'project' as const })),
        ...[...new Set(snapshot.threadIds)].map(id => ({ id, kind: 'thread' as const })),
    ]
    // Bound both RPC concurrency and each atomic cache update. Yield between batches
    // so live notifications can advance versions while large directories catch up.
    for (let offset = 0; offset < jobs.length && !signal.aborted;) {
        const batch = jobs.slice(offset, offset + 16)
        const threads: NativeRecord[] = [], projects: NativeRecord[] = []
        let index = 0
        await Promise.all(Array.from({ length: Math.min(3, batch.length) }, async () => {
            while (!signal.aborted) {
                const job = batch[index++]
                if (!job) return
                try {
                    const value = await (job.kind === 'thread' ? adapter.readThread(job.id, signal) : adapter.readProject(job.id, signal))
                    if (signal.aborted) return
                    result.checked++
                    if (text(value.id) !== job.id) { result.failed++; continue }
                    if (job.kind === 'thread') threads.push(value)
                    else projects.push(value)
                } catch {
                    if (!signal.aborted) { result.checked++; result.failed++ }
                    // Missing/unmaterialized/offline metadata cannot delete a cached choice.
                }
            }
        }))
        if (signal.aborted) return result
        if (threads.length || projects.length) await adapter.apply({ threads, projects }, snapshot.versions)
        // A tracked chat may have moved to a previously untracked project during
        // the gap. Capture that newly relevant project's current version before
        // reading its name, rather than retaining the old workspace label.
        const newTargets = new Set(threads.flatMap(thread => {
            const id = text(thread.projectId)
            return id && !knownProjects.has(id) ? [id] : []
        }))
        if (newTargets.size && !signal.aborted) {
            const latest = await adapter.snapshot()
            if (signal.aborted) return result
            const added = latest.projectIds.filter(id => newTargets.has(id) && !knownProjects.has(id)).map(id => {
                knownProjects.add(id)
                snapshot.versions[`project:${id}`] = latest.versions[`project:${id}`] ?? 0
                snapshot.versions[`event:project:${id}`] = latest.versions[`event:project:${id}`] ?? 0
                return { id, kind: 'project' as const }
            })
            jobs.splice(offset + batch.length, 0, ...added)
        }
        offset += batch.length
        if (offset < jobs.length) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    result.complete = !signal.aborted && result.failed === 0
    return result
}

export class NativeDirectoryCatchup {
    private flights = new Map<string, { signal: AbortSignal; promise: Promise<DirectoryCatchupResult> }>()
    run(key: string, signal: AbortSignal, work: () => Promise<DirectoryCatchupResult>): Promise<DirectoryCatchupResult> {
        const active = this.flights.get(key)
        if (active && !active.signal.aborted) return active.promise
        const current = { signal, promise: Promise.resolve().then(work) }
        this.flights.set(key, current)
        void current.promise.finally(() => {
            if (this.flights.get(key) === current) this.flights.delete(key)
        }).catch(() => {})
        return current.promise
    }
}

const reconcilers = new WeakMap<NativeRegistry, NativeDirectoryCatchup>()

export function reconcileNativeDirectory(registry: NativeRegistry, namespace: string, endpointId: string, signal: AbortSignal): Promise<DirectoryCatchupResult> {
    let reconciler = reconcilers.get(registry)
    if (!reconciler) { reconciler = new NativeDirectoryCatchup(); reconcilers.set(registry, reconciler) }
    return reconciler.run(JSON.stringify([namespace, endpointId]), signal, async () => {
        const endpoint = registry.get(namespace, endpointId)
        if (!endpoint || signal.aborted) return { complete: false, checked: 0, failed: 0 }
        const snapshot = await registry.trackedDirectorySnapshot(namespace, endpointId)
        if (signal.aborted) return { complete: false, checked: 0, failed: 0 }
        if (!snapshot.threadIds.length && !snapshot.projectIds.length) return { complete: true, checked: 0, failed: 0 }
        // Reuse one detachable connection for this pass, with at most three requests
        // outstanding. No thread subscription, resume, turns, or item reads.
        return endpoint.service.withConnection(async client => {
            const abort = () => client.close('Native directory catch-up cancelled')
            signal.addEventListener('abort', abort, { once: true })
            try {
                if (signal.aborted) return { complete: false, checked: 0, failed: 0 }
                return await reconcileTrackedDirectory({
                    snapshot: () => registry.trackedDirectorySnapshot(namespace, endpointId),
                    readThread: async id => record(record(await client.request('thread/read', { threadId: id, includeTurns: false })).thread),
                    readProject: async id => record(record(await client.request('project/read', { projectId: id })).project),
                    apply: (values, versions) => signal.aborted ? Promise.resolve() : registry.applyDirectoryReconciliation(namespace, endpointId, values, versions),
                }, signal, snapshot)
            } finally { signal.removeEventListener('abort', abort) }
        })
    })
}
