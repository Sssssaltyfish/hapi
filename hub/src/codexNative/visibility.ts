import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { NativeVisibilityState } from '@hapi/protocol/codexNativeVisibility'
import { isNativeBackgroundThread } from '@hapi/protocol/codexNativeVisibility'
import { getSettingsFile, readSettingsOrThrowCached, updateSettings } from '../config/settings'
import { record, text, type NativeRecord } from './transport'

const projectSchema = z.object({ id: z.string(), name: z.string().optional(), members: z.array(z.string()),
    nextCursor: z.string().nullable(), complete: z.boolean(), scanMembers: z.array(z.string()).optional(),
    visitedCursors: z.array(z.string()).optional(), scanId: z.string().optional() })
const endpointSchema = z.object({ namespace: z.string(), endpointId: z.string(), initialized: z.boolean(),
    individual: z.array(z.string()), hidden: z.array(z.string()), projects: z.array(projectSchema),
    threads: z.record(z.string(), z.record(z.string(), z.unknown())), threadVersions: z.record(z.string(), z.number()).default({}),
    projectVersions: z.record(z.string(), z.number()).default({}) })
export type VisibilityEndpoint = z.infer<typeof endpointSchema>
const empty = (namespace: string, endpointId: string): VisibilityEndpoint => ({ namespace, endpointId,
    initialized: false, individual: [], hidden: [], projects: [], threads: {}, threadVersions: {}, projectVersions: {} })
const fields = ['id', 'name', 'preview', 'cwd', 'model', 'reasoningEffort', 'createdAt', 'updatedAt', 'status',
    'projectId', 'desktopProjectId', 'desktopProject', 'hasConversationContent', 'source', 'threadSource', 'originator']
export function directorySnapshot(value: NativeRecord): NativeRecord {
    return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}
export function visibleThreadIds(state: VisibilityEndpoint): string[] {
    const hidden = new Set(state.hidden)
    const ordinaryMembers = state.projects.flatMap(project => project.members)
        .filter(id => !isNativeBackgroundThread(state.threads[id] ?? {}))
    return [...new Set([...state.individual, ...ordinaryMembers])]
        .filter(id => !hidden.has(id) && state.threads[id])
}
export function visibilityState(state: VisibilityEndpoint): NativeVisibilityState {
    const visible = visibleThreadIds(state)
    const visibleSet = new Set(visible)
    return { initialized: state.initialized, threadIds: visible, hiddenThreadIds: state.hidden,
        projects: state.projects.map(project => ({ id: project.id, ...(project.name ? { name: project.name } : {}),
            memberCount: project.members.filter(id => visibleSet.has(id)).length,
            nextCursor: project.nextCursor, complete: project.complete })) }
}
export function observeDirectoryThread(state: VisibilityEndpoint, value: NativeRecord, visible?: ReadonlySet<string>): void {
    const id = text(value.id)
    if (!id) return
    const known = state.threads[id]
    const selected = state.projects.find(project => project.id === value.projectId)
    if (!known && (!selected || isNativeBackgroundThread(value))) return
    const next = { ...known, ...directorySnapshot(value) }
    if (isDeepStrictEqual(known, next)) return
    const wasVisible = visible ? visible.has(id) : visibleThreadIds(state).includes(id)
    state.threads[id] = next
    state.threadVersions[id] = (state.threadVersions[id] ?? 0) + 1
    if (Object.hasOwn(value, 'projectId')) {
        // Moving a displayed chat is not a request to hide it. Preserve its
        // visibility even when it leaves the project that originally imported it.
        if (known?.projectId !== value.projectId && wasVisible && !state.individual.includes(id)) state.individual.push(id)
        for (const project of state.projects) {
            project.members = project.members.filter(member => member !== id)
            if (project.scanMembers) project.scanMembers = project.scanMembers.filter(member => member !== id)
            if (project.id === value.projectId) {
                project.members.push(id)
                if (project.scanMembers) project.scanMembers.push(id)
            }
        }
        // Desktop's inferred membership may be stale after an authoritative move.
        if (known?.projectId !== value.projectId) {
            delete state.threads[id].desktopProject
            delete state.threads[id].desktopProjectId
        }
    }
}

export function observeDirectoryProject(state: VisibilityEndpoint, project: NativeRecord): void {
    const id = text(project.id)
    if (!id) return
    const selected = state.projects.find(value => value.id === id)
    let changed = false
    if (selected && text(project.name) && selected.name !== text(project.name)) { selected.name = text(project.name); changed = true }
    for (const thread of Object.values(state.threads)) if (thread.projectId === id) {
        const existing = record(thread.desktopProject)
        const next = { id, name: text(project.name) ?? text(existing.name) ?? id,
            path: Array.isArray(project.roots) ? text(record(project.roots[0]).path) ?? '' : text(existing.path) ?? '' }
        if (thread.desktopProjectId !== id || !isDeepStrictEqual(existing, next)) {
            thread.desktopProjectId = id; thread.desktopProject = next; changed = true
        }
    }
    if (changed) state.projectVersions[id] = (state.projectVersions[id] ?? 0) + 1
}

/** Uses the existing cross-process settings lock and atomic writer. */
export class NativeVisibilityStore {
    private readonly file?: string
    private memory: VisibilityEndpoint[] = []
    private pending: Promise<unknown> = Promise.resolve()
    constructor(dataDir?: string) { if (dataDir) this.file = getSettingsFile(dataDir) }
    private parse(value: unknown): VisibilityEndpoint[] {
        return z.array(endpointSchema).parse(value ?? [])
    }
    async read(namespace: string, endpointId: string): Promise<VisibilityEndpoint> {
        await this.pending
        const entries = this.file ? this.parse((await readSettingsOrThrowCached(this.file)).nativeCodexVisibility) : this.memory
        return structuredClone(entries.find(entry => entry.namespace === namespace && entry.endpointId === endpointId) ?? empty(namespace, endpointId))
    }
    async change(namespace: string, endpointId: string, change: (state: VisibilityEndpoint) => void): Promise<{ state: VisibilityEndpoint; changed: boolean }> {
        const run = async () => {
            const mutate = (entries: VisibilityEndpoint[]) => {
                const state = entries.find(entry => entry.namespace === namespace && entry.endpointId === endpointId) ?? empty(namespace, endpointId)
                const before = structuredClone(state)
                change(state)
                const changed = !isDeepStrictEqual(before, state)
                if (Object.keys(state.threads).length > 50_000) throw new Error('Native tracked thread limit reached')
                const next = entries.filter(entry => entry.namespace !== namespace || entry.endpointId !== endpointId)
                next.push(state)
                return { next, state, changed }
            }
            if (this.file) return updateSettings(this.file, settings => {
                const { next, state, changed } = mutate(this.parse(settings.nativeCodexVisibility))
                return { settings: { ...settings, nativeCodexVisibility: next }, result: { state: structuredClone(state), changed }, write: changed }
            })
            const { next, state, changed } = mutate(structuredClone(this.memory)); if (changed) this.memory = next; return { state: structuredClone(state), changed }
        }
        const result = this.pending.then(run, run)
        this.pending = result.catch(() => {})
        return result
    }
}
