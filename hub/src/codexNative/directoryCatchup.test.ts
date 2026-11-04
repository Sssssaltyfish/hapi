import { describe, expect, test } from 'bun:test'
import { NativeDirectoryCatchup, reconcileNativeDirectory, reconcileTrackedDirectory } from './directoryCatchup'
import type { NativeRecord } from './transport'
import type { NativeRegistry } from './registry'

describe('Tracked native directory catch-up', () => {
    test('bounds concurrent metadata I/O and applies batches without deleting failed or missing entries', async () => {
        let active = 0, peak = 0, snapshots = 0
        const applied: Array<{ threads?: NativeRecord[]; projects?: NativeRecord[] }> = []
        const read = async (id: string) => {
            peak = Math.max(peak, ++active)
            await new Promise(resolve => setTimeout(resolve, 0))
            active--
            if (id === 't5') throw Error('Offline or missing')
            return { id: id === 't6' ? 'wrong-id' : id, name: 'Current metadata' }
        }
        const versions = { 'thread:t0': 4, 'project:p': 2 }
        const result = await reconcileTrackedDirectory({
            snapshot: async () => { snapshots++; return { threadIds: [...Array.from({ length: 40 }, (_, index) => `t${index}`), 't0'], projectIds: ['p', 'p'], versions } },
            readThread: read, readProject: read,
            apply: async (values, capturedVersions) => {
                expect(capturedVersions).toBe(versions)
                expect((values.threads?.length ?? 0) + (values.projects?.length ?? 0)).toBeLessThanOrEqual(16)
                applied.push(values)
            },
        }, new AbortController().signal)
        expect(snapshots).toBe(1)
        expect(peak).toBe(3)
        expect(result).toEqual({ complete: false, checked: 41, failed: 2 })
        expect(applied).toHaveLength(3)
        expect(applied.flatMap(values => values.threads ?? []).map(thread => thread.id)).not.toContain('t5')
        expect(applied.flatMap(values => values.threads ?? []).map(thread => thread.id)).not.toContain('wrong-id')
        expect(applied.flatMap(values => values.projects ?? [])).toHaveLength(1)
    })
    test('aborts a departing observer without applying late reads or starting further batches', async () => {
        const controller = new AbortController()
        let reads = 0, applies = 0, release: (() => void) | undefined
        const blocked = new Promise<void>(resolve => { release = resolve })
        const work = reconcileTrackedDirectory({
            snapshot: async () => ({ threadIds: Array.from({ length: 40 }, (_, index) => `t${index}`), projectIds: [], versions: {} }),
            readThread: async id => { reads++; await blocked; return { id } },
            readProject: async id => ({ id }),
            apply: async () => { applies++ },
        }, controller.signal)
        await Promise.resolve(); await Promise.resolve()
        expect(reads).toBe(3)
        controller.abort(); release!()
        expect(await work).toMatchObject({ complete: false })
        expect(reads).toBe(3)
        expect(applies).toBe(0)
    })
    test('fetches the newly relevant project after a gap move with a freshly captured version', async () => {
        let moved = false, snapshots = 0
        const projects: string[] = []
        await reconcileTrackedDirectory({
            snapshot: async () => {
                snapshots++
                return { threadIds: ['t'], projectIds: moved ? ['old', 'new'] : ['old'], versions: { 'thread:t': 1, 'project:old': 2, ...moved ? { 'project:new': 7, 'event:project:new': 9 } : {} } }
            },
            readThread: async id => ({ id, projectId: 'new' }),
            readProject: async id => { projects.push(id); return { id, name: id } },
            apply: async (values, versions) => {
                if (values.threads?.length) moved = true
                if (values.projects?.some(project => project.id === 'new')) {
                    expect(versions['project:new']).toBe(7)
                    expect(versions['event:project:new']).toBe(9)
                }
            },
        }, new AbortController().signal)
        expect(projects).toEqual(['old', 'new'])
        expect(snapshots).toBe(2)
    })
    test('deduplicates a healthy endpoint pass but allows a fresh pass after its observer is aborted', async () => {
        const catchup = new NativeDirectoryCatchup(), first = new AbortController(), replacement = new AbortController()
        let runs = 0, release: (() => void) | undefined
        const blocked = new Promise<void>(resolve => { release = resolve })
        const work = async () => { runs++; await blocked; return { complete: true, checked: 1, failed: 0 } }
        const a = catchup.run('endpoint', first.signal, work)
        const b = catchup.run('endpoint', first.signal, work)
        expect(a).toBe(b)
        await Promise.resolve()
        expect(runs).toBe(1)
        first.abort()
        const c = catchup.run('endpoint', replacement.signal, work)
        expect(c).not.toBe(a)
        release!()
        await Promise.all([a, b, c])
        expect(runs).toBe(2)
    })
    test('uses one reusable metadata connection and only explicit tracked IDs', async () => {
        let connections = 0
        const requests: Array<{ method: string; params: unknown }> = []
        const updates: unknown[] = []
        const registry = {
            get: () => ({ service: { withConnection: async (action: (client: unknown) => Promise<unknown>) => {
                connections++
                return action({ close() {}, request: async (method: string, params: any) => {
                    requests.push({ method, params })
                    return method === 'thread/read' ? { thread: { id: params.threadId, projectId: 'p' } } : { project: { id: params.projectId, name: 'Current' } }
                } })
            } } }),
            trackedDirectorySnapshot: async () => ({ threadIds: ['t'], projectIds: ['p'], versions: { 'thread:t': 1, 'project:p': 2 } }),
            applyDirectoryReconciliation: async (_namespace: string, _endpoint: string, values: unknown) => { updates.push(values) },
        } as unknown as NativeRegistry
        const signal = new AbortController().signal
        const [first, second] = await Promise.all([
            reconcileNativeDirectory(registry, 'owner', 'machine', signal),
            reconcileNativeDirectory(registry, 'owner', 'machine', signal),
        ])
        expect(first).toEqual(second)
        expect(connections).toBe(1)
        expect(requests).toEqual([
            { method: 'project/read', params: { projectId: 'p' } },
            { method: 'thread/read', params: { threadId: 't', includeTurns: false } },
        ])
        expect(updates).toHaveLength(1)
    })
})
