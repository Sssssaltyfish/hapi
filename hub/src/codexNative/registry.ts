import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { toSessionSummary, type Session, type SessionSummary } from '@hapi/protocol'
import { NativeService, nativeConfig, type NativeConfig } from './service'
import { record, text, type NativeRecord } from './transport'
import { NativeMachineSettings, nativeDisplayAddress, nativeMachineError, type NewNativeEndpoint } from './machineSettings'
import { isNativeBackgroundThread, NATIVE_ORDINARY_SOURCE_KINDS, type NativeVisibilityAction, type NativeVisibilityResponse } from '@hapi/protocol/codexNativeVisibility'
import { NativeVisibilityStore, directorySnapshot, observeDirectoryThread, observeDirectoryProject, visibleThreadIds, visibilityState, type VisibilityEndpoint } from './visibility'

export type NativeEndpointConfig = NativeConfig & {
    id: string
    label: string
    displayName?: string
    source?: 'env' | 'settings'
    defaultCwd?: string
    allowedRoots?: string[]
    fileAccess?: 'workspace' | 'host'
    legacyMachineIds?: string[]
    legacyHosts?: string[]
}
const EndpointSchema = z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    label: z.string().min(1),
    endpoint: z.string().regex(/^(unix:\/\/|wss?:\/\/)/),
    namespace: z.string(),
    token: z.string().optional(),
    desktopStatePath: z.string().optional(),
    desktopHostId: z.string().optional(),
    defaultCwd: z.string().optional(),
    allowedRoots: z.array(z.string()).max(32).optional(),
    fileAccess: z.enum(['workspace', 'host']).optional(),
    legacyMachineIds: z.array(z.string()).optional(),
    legacyHosts: z.array(z.string()).optional()
})
export const nativeSessionId = (endpointId: string, threadId: string) => `codex-native:${endpointId}:${threadId}`
export function parseNativeSessionId(id: string): { endpointId: string; threadId: string } | undefined {
    const match = /^codex-native:([^:]+):(.+)$/.exec(id)
    return match ? { endpointId: match[1], threadId: match[2] } : undefined
}
export function configuredNativeEndpoints(): NativeEndpointConfig[] {
    if (process.env.HAPI_CODEX_NATIVE_ENDPOINTS) {
        const endpoints = z.array(EndpointSchema).max(16).parse(JSON.parse(process.env.HAPI_CODEX_NATIVE_ENDPOINTS))
        if (new Set(endpoints.map(endpoint => endpoint.id)).size !== endpoints.length) throw new Error('Duplicate native endpoint ID')
        return endpoints
    }
    const config = nativeConfig()
    return config.endpoint && config.namespace !== undefined ? [{
        ...config,
        id: 'default',
        label: 'Codex',
        defaultCwd: process.env.HAPI_CODEX_NATIVE_CWD,
        fileAccess: z.enum(['workspace', 'host']).optional().parse(process.env.HAPI_CODEX_NATIVE_FILE_ACCESS),
        legacyMachineIds: process.env.HAPI_CODEX_NATIVE_LEGACY_MACHINE_IDS?.split(',').map(value => value.trim()).filter(Boolean),
        legacyHosts: process.env.HAPI_CODEX_NATIVE_LEGACY_HOSTS?.split(',').map(value => value.trim()).filter(Boolean)
    }] : []
}
export function nativeSession(endpoint: NativeEndpointConfig, thread: NativeRecord, available = true, error?: string, legacy?: Session): Session {
    const timestamp = (value: unknown, fallback: number) => typeof value === 'number' ? value < 1e12 ? value * 1000 : value : fallback
    const now = Date.now()
    const id = String(thread.id)
    const project = record(thread.desktopProject)
    const projectId = text(thread.projectId)
    const updatedAt = timestamp(thread.updatedAt, legacy?.updatedAt ?? now)
    const active = record(thread.status).type === 'active'
    return {
        id: nativeSessionId(endpoint.id, id),
        namespace: endpoint.namespace!,
        seq: 0,
        createdAt: timestamp(thread.createdAt, legacy?.createdAt ?? updatedAt),
        updatedAt,
        active: available,
        activeAt: updatedAt,
        thinking: available && active,
        thinkingAt: active ? updatedAt : 0,
        hasConversationContent: thread.hasConversationContent !== false,
        metadataVersion: updatedAt,
        agentStateVersion: updatedAt,
        metadata: {
            path: text(thread.cwd) ?? legacy?.metadata?.path ?? endpoint.defaultCwd ?? '/',
            host: endpoint.label,
            name: text(thread.name) ?? text(thread.title) ?? text(thread.preview) ?? (!available ? legacy?.metadata?.name : undefined),
            flavor: 'codex',
            codexSessionId: id,
            machineId: `codex-native:${endpoint.id}`,
            nativeCodex: {
                endpointId: endpoint.id,
                threadId: id,
                available,
                ...(error ? { error } : {}),
                ...(projectId ? { projectId,
                    ...(text(project.name) ? { projectName: text(project.name) } : {}),
                    ...(text(project.path) ? { projectPath: text(project.path) } : {}) } : {})
            },
            lifecycleState: active ? 'running' : 'idle',
            capabilities: { concurrentClients: true, terminal: false, permissionModes: [] }
        },
        agentState: { controlledByUser: false, requests: {} },
        model: text(thread.model) ?? (!available ? legacy?.model : null) ?? null,
        modelReasoningEffort: text(thread.reasoningEffort) ?? (!available ? legacy?.modelReasoningEffort : null) ?? null,
        effort: text(thread.reasoningEffort) ?? (!available ? legacy?.effort : null) ?? null,
        serviceTier: null
    }
}

export class NativeRegistry {
    readonly endpoints: Array<{ config: NativeEndpointConfig; service: NativeService }>
    private readonly machineSettings?: NativeMachineSettings
    private refreshing?: Promise<void>
    private readonly visibility: NativeVisibilityStore
    private readonly migrations = new Map<string, Promise<void>>()
    private readonly migrationRetryAt = new Map<string, number>()
    private readonly migrationErrors = new Map<string, string>()
    private readonly imports = new Map<string, Promise<NativeVisibilityResponse>>()
    private readonly visibilityListeners = new Map<string, Set<() => void>>()
    private directoryEpoch = 0
    // No-op notifications do not change persisted cache revisions, but must
    // still invalidate older RPCs. Retain only snapshot entities and live events.
    private readonly directoryEvents = new Map<string, {
        service: NativeService
        entities: Map<string, { epoch: number; inFlight: number; captured: boolean }>
    }>()

    constructor(
        private readonly configs = configuredNativeEndpoints(),
        private readonly factory = (config: NativeEndpointConfig) => new NativeService(config),
        options?: { dataDir: string }
    ) {
        this.endpoints = configs.map(config => ({ config, service: factory(config) }))
        this.visibility = new NativeVisibilityStore(options?.dataDir)
        if (options) this.machineSettings = new NativeMachineSettings(options.dataDir)
    }

    refresh(): Promise<void> {
        if (!this.machineSettings) return Promise.resolve()
        if (!this.refreshing) {
            this.refreshing = this.refreshSettings().finally(() => { this.refreshing = undefined })
        }
        return this.refreshing
    }

    private async refreshSettings(): Promise<void> {
        const settings = await this.machineSettings!.read()
        const configs: NativeEndpointConfig[] = [
            ...this.configs.map(config => ({ ...config, source: 'env' as const })),
            ...settings.endpoints.map(config => ({
                ...config,
                label: config.displayName || 'Codex Native',
                source: 'settings' as const
            }))
        ]
        if (configs.length > 16) throw new Error('Native machine limit reached')
        if (new Set(configs.map(config => config.id)).size !== configs.length) {
            throw new Error('Duplicate native machine ID across environment and settings.json')
        }
        const next = configs.map(config => {
            const name = settings.names.find(name => name.id === config.id && name.namespace === config.namespace)?.displayName
                || config.displayName
            if (name) config = { ...config, label: name, displayName: name }
            const existing = this.endpoints.find(endpoint => endpoint.config.id === config.id
                && endpoint.config.namespace === config.namespace && endpoint.config.endpoint === config.endpoint
                && endpoint.config.token === config.token)
            return { config, service: existing?.service ?? this.factory(config) }
        })
        const retained = new Set(next.map(endpoint => endpoint.service))
        for (const endpoint of this.endpoints) {
            if (!retained.has(endpoint.service)) endpoint.service.dispose()
        }
        this.endpoints.splice(0, this.endpoints.length, ...next)
        const active = new Map(next.map(endpoint => [JSON.stringify([endpoint.config.namespace, endpoint.config.id]), endpoint.service]))
        for (const [key, guard] of this.directoryEvents) if (active.get(key) !== guard.service) this.directoryEvents.delete(key)
    }

    summary(config: NativeEndpointConfig) {
        return {
            id: config.id,
            label: config.label,
            ...(config.desktopHostId ? { desktopHostId: config.desktopHostId } : {}),
            baseLabel: this.configs.find(endpoint => endpoint.id === config.id && endpoint.namespace === config.namespace)?.label ?? 'Codex Native',
            ...(config.displayName ? { displayName: config.displayName } : {}),
            address: nativeDisplayAddress(config.endpoint!),
            ...(config.defaultCwd ? { defaultCwd: config.defaultCwd } : {}),
            source: config.source ?? 'env' as 'env' | 'settings'
        }
    }

    async add(namespace: string, input: NewNativeEndpoint) {
        if (!this.machineSettings) throw new Error('Native machine settings are unavailable')
        await this.refresh()
        if (this.endpoints.length >= 16) throw new Error('Native machine limit reached')
        if (this.visible(namespace).some(endpoint => endpoint.config.endpoint === input.address)) {
            throw new Error('This native connection is already configured')
        }
        const saved = await this.machineSettings.add(namespace, input, this.configs.length)
        await this.refreshing
        await this.refresh()
        return this.summary(this.get(namespace, saved.id)!.config)
    }

    async rename(namespace: string, id: string, displayName: string) {
        if (!this.machineSettings) throw new Error('Native machine settings are unavailable')
        await this.refresh()
        if (!this.get(namespace, id)) return undefined
        await this.machineSettings.rename(namespace, id, displayName)
        await this.refreshing
        await this.refresh()
        return this.summary(this.get(namespace, id)!.config)
    }
    visible(namespace: string) {
        return this.endpoints.filter(endpoint => endpoint.config.namespace === namespace && endpoint.service.authorized(namespace))
    }
    get(namespace: string, id?: string) {
        const endpoints = this.visible(namespace)
        return id ? endpoints.find(endpoint => endpoint.config.id === id) : endpoints[0]
    }
    alias(session: Session, namespace: string) {
        if (session.namespace !== namespace || session.metadata?.flavor !== 'codex') return undefined
        const marker = session.metadata.nativeCodex
        const threadId = marker?.threadId ?? session.metadata.codexSessionId ?? session.metadata.codexSourceSessionId
        if (!threadId) return undefined
        const candidates = this.visible(namespace)
        const endpoint = marker ? candidates.find(e => e.config.id === marker.endpointId)
            : candidates.find(e => e.config.legacyMachineIds?.includes(session.metadata?.machineId ?? '') || e.config.legacyHosts?.includes(session.metadata?.host ?? ''))
        return endpoint ? { endpoint, threadId } : undefined
    }
    async resolve(namespace: string, id: string, legacy?: Session): Promise<Session | undefined> {
        await this.refresh()
        const parsed = parseNativeSessionId(id)
        const binding = parsed ? { endpoint: this.get(namespace, parsed.endpointId), threadId: parsed.threadId } : legacy ? this.alias(legacy, namespace) : undefined
        if (!binding?.endpoint) {
            const marker = legacy?.namespace === namespace ? legacy.metadata?.nativeCodex : undefined
            if (!parsed && marker) {
                return nativeSession(
                    { id: marker.endpointId, label: 'Codex', namespace },
                    { id: marker.threadId },
                    false,
                    'Native endpoint is not configured for this namespace',
                    legacy
                )
            }
            return undefined
        }
        const { endpoint, threadId } = binding
        try {
            const response = record(await endpoint.service.readThread(threadId))
            await this.observeThread(namespace, endpoint.config.id, record(response.thread))
            return nativeSession(endpoint.config, { ...record(response.thread), id: threadId }, true, undefined, legacy)
        } catch (error) {
            return nativeSession(endpoint.config, { id: threadId }, false, nativeMachineError(error, endpoint.config), legacy)
        }
    }
    private summaries(endpoint: { config: NativeEndpointConfig }, state: VisibilityEndpoint): SessionSummary[] {
        const error = this.migrationErrors.get(JSON.stringify([endpoint.config.namespace, endpoint.config.id]))
        return visibleThreadIds(state).map(id => toSessionSummary(nativeSession(endpoint.config, state.threads[id], !error, error)))
    }
    subscribeVisibility(namespace: string, endpointId: string, listener: () => void): () => void {
        const key = JSON.stringify([namespace, endpointId])
        const listeners = this.visibilityListeners.get(key) ?? new Set<() => void>()
        listeners.add(listener); this.visibilityListeners.set(key, listeners)
        return () => { listeners.delete(listener); if (!listeners.size) this.visibilityListeners.delete(key) }
    }
    private async changeState(namespace: string, endpointId: string, change: (state: VisibilityEndpoint) => void, notify = true): Promise<VisibilityEndpoint> {
        const result = await this.visibility.change(namespace, endpointId, change)
        if (!result.changed || !notify) return result.state
        for (const listener of this.visibilityListeners.get(JSON.stringify([namespace, endpointId])) ?? []) {
            try { listener() } catch { /* A disconnected browser cannot fail a committed local choice. */ }
        }
        return result.state
    }

    async observeThread(namespace: string, endpointId: string, thread: NativeRecord, notify = true): Promise<void> {
        return this.observeThreads(namespace, endpointId, [thread], notify)
    }
    async observeThreads(namespace: string, endpointId: string, threads: NativeRecord[], notify = true): Promise<void> {
        if (!this.get(namespace, endpointId)) return
        const current = await this.visibility.read(namespace, endpointId)
        const observed = threads.filter(thread => {
            const id = text(thread.id)
            const classified = thread.source !== undefined || thread.threadSource === 'user'
            return id && (current.threads[id] || (classified && !isNativeBackgroundThread(thread) && current.projects.some(project => project.id === thread.projectId)))
        })
        if (!observed.length) return
        this.migrationErrors.delete(JSON.stringify([namespace, endpointId]))
        await this.changeState(namespace, endpointId, state => {
            const visible = new Set(visibleThreadIds(state))
            for (const thread of observed) observeDirectoryThread(state, thread, visible)
        }, notify)
    }
    async observeProject(namespace: string, endpointId: string, project: NativeRecord, notify = true): Promise<void> {
        const id = text(project.id)
        if (!id || !this.get(namespace, endpointId)) return
        const current = await this.visibility.read(namespace, endpointId)
        if (!current.projects.some(value => value.id === id) && !Object.values(current.threads).some(thread => thread.projectId === id)) return
        await this.changeState(namespace, endpointId, state => observeDirectoryProject(state, project), notify)
    }
    async trackedDirectorySnapshot(namespace: string, endpointId: string): Promise<{ threadIds: string[]; projectIds: string[]; versions: Record<string, number> }> {
        if (!this.get(namespace, endpointId)) throw new Error('Native endpoint unavailable')
        const state = await this.visibility.read(namespace, endpointId)
        const threadIds = visibleThreadIds(state)
        const projectIds = [...new Set([...state.projects.map(project => project.id), ...threadIds.flatMap(id => text(state.threads[id].projectId) ?? [])])]
        const eventVersions = this.captureDirectoryEvents(namespace, endpointId,
            [...threadIds.map(id => `thread:${id}`), ...projectIds.map(id => `project:${id}`)], true)
        return { threadIds, projectIds, versions: { ...eventVersions, ...Object.fromEntries([
            ...threadIds.map(id => [`thread:${id}`, state.threadVersions[id] ?? 0]),
            ...projectIds.map(id => [`project:${id}`, state.projectVersions[id] ?? 0]),
        ]) } }
    }
    private eventGuards(namespace: string, endpointId: string) {
        const endpoint = this.get(namespace, endpointId)!
        const key = JSON.stringify([namespace, endpointId])
        let current = this.directoryEvents.get(key)
        if (!current || current.service !== endpoint.service) {
            current = { service: endpoint.service, entities: new Map() }
            this.directoryEvents.set(key, current)
        }
        return current.entities
    }
    private captureDirectoryEvents(namespace: string, endpointId: string, keys: string[], prune = false): Record<string, number> {
        const guards = this.eventGuards(namespace, endpointId), selected = new Set(keys)
        if (prune) for (const [key, guard] of guards) if (!selected.has(key) && !guard.inFlight) guards.delete(key)
        return Object.fromEntries(keys.map(key => {
            let guard = guards.get(key)
            if (!guard) { guard = { epoch: ++this.directoryEpoch, inFlight: 0, captured: true }; guards.set(key, guard) }
            guard.captured = true
            return [`event:${key}`, guard.inFlight ? -1 : guard.epoch]
        }))
    }
    private eventVersionMatches(namespace: string, endpointId: string, key: string, versions: Record<string, number>): boolean {
        if (!this.get(namespace, endpointId)) return false
        const guard = this.eventGuards(namespace, endpointId).get(key)
        return Boolean(guard && !guard.inFlight && versions[`event:${key}`] === guard.epoch)
    }
    async applyDirectoryReconciliation(namespace: string, endpointId: string, data: { threads?: NativeRecord[]; projects?: NativeRecord[] }, versions: Record<string, number>): Promise<void> {
        if (!this.get(namespace, endpointId)) return
        await this.changeState(namespace, endpointId, state => {
            const visible = new Set(visibleThreadIds(state))
            for (const thread of data.threads ?? []) {
                const id = text(thread.id)
                if (!id || !visible.has(id) || (state.threadVersions[id] ?? 0) !== versions[`thread:${id}`]) continue
                if (!this.eventVersionMatches(namespace, endpointId, `thread:${id}`, versions)) continue
                observeDirectoryThread(state, thread, visible)
            }
            for (const project of data.projects ?? []) {
                const id = text(project.id)
                if (!id || (state.projectVersions[id] ?? 0) !== versions[`project:${id}`]) continue
                if (!this.eventVersionMatches(namespace, endpointId, `project:${id}`, versions)) continue
                if (!state.projects.some(project => project.id === id) && ![...visible].some(threadId => state.threads[threadId]?.projectId === id)) continue
                observeDirectoryProject(state, project)
            }
        })
    }
    async observeCatalogEvent(namespace: string, endpointId: string, event: { method: string; params?: unknown }): Promise<void> {
        if (!this.get(namespace, endpointId)) return
        const params = record(event.params)
        const threadId = text(params.threadId) ?? text(record(params.thread).id)
        const projectId = text(params.projectId) ?? text(record(params.project).id)
        const keys = event.method === 'project/changed' ? projectId ? [`project:${projectId}`] : []
            : threadId ? [`thread:${threadId}`, ...(event.method === 'thread/project/updated' && projectId ? [`project:${projectId}`] : [])] : []
        const guards = this.eventGuards(namespace, endpointId)
        const active = keys.map(key => {
            let guard = guards.get(key)
            if (!guard) { guard = { epoch: 0, inFlight: 0, captured: false }; guards.set(key, guard) }
            guard.epoch = ++this.directoryEpoch; guard.inFlight++
            return { key, guard }
        })
        try { await this.applyCatalogEvent(namespace, endpointId, event) }
        finally {
            for (const { key, guard } of active) {
                guard.inFlight--; guard.epoch = ++this.directoryEpoch
                if (!guard.captured && !guard.inFlight) guards.delete(key)
            }
        }
    }
    private async applyCatalogEvent(namespace: string, endpointId: string, event: { method: string; params?: unknown }): Promise<void> {
        const params = record(event.params)
        if (event.method === 'project/changed') {
            const project = record(params.project), projectId = text(project.id) ?? text(params.projectId)
            if (!projectId) return
            const state = await this.visibility.read(namespace, endpointId)
            if (!state.projects.some(project => project.id === projectId) && !Object.values(state.threads).some(thread => thread.projectId === projectId)) return
            if (params.changeType === 'deleted') {
                await this.changeState(namespace, endpointId, current => {
                    const visible = new Set(visibleThreadIds(current))
                    for (const thread of Object.values(current.threads)) if (thread.projectId === projectId) {
                        const id = String(thread.id)
                        if (visible.has(id) && !current.individual.includes(id)) current.individual.push(id)
                        thread.projectId = null; delete thread.desktopProject; delete thread.desktopProjectId
                        current.threadVersions[id] = (current.threadVersions[id] ?? 0) + 1
                    }
                    current.projects = current.projects.filter(project => project.id !== projectId)
                    current.projectVersions[projectId] = (current.projectVersions[projectId] ?? 0) + 1
                }, false)
                return
            }
            const endpoint = this.get(namespace, endpointId)
            if (!endpoint) return
            const metadata = text(project.name) ? project : record(record(await endpoint.service.call('project/read', { projectId })).project)
            await this.observeProject(namespace, endpointId, metadata, false)
            return
        }
        const id = text(params.threadId) ?? text(record(params.thread).id)
        if (!id) return
        if (event.method === 'thread/archived' || event.method === 'thread/deleted') {
            if (!(await this.visibility.read(namespace, endpointId)).threads[id]) return
            await this.changeState(namespace, endpointId, state => {
                delete state.threads[id]
                state.threadVersions[id] = (state.threadVersions[id] ?? 0) + 1
                state.individual = state.individual.filter(value => value !== id)
                for (const project of state.projects) {
                    project.members = project.members.filter(value => value !== id)
                    if (project.scanMembers) project.scanMembers = project.scanMembers.filter(value => value !== id)
                }
            }, false)
            return
        }
        let observed: NativeRecord = { ...record(params.thread), id,
            ...(Object.hasOwn(params, 'projectId') ? { projectId: params.projectId } : {}),
            ...(typeof params.name === 'string' || params.name === null ? { name: params.name } : {}),
            ...(typeof params.threadName === 'string' || params.threadName === null ? { name: params.threadName } : {}),
            ...(params.status ? { status: params.status } : {}) }
        if (event.method === 'thread/project/updated' && observed.source === undefined) {
            const state = await this.visibility.read(namespace, endpointId)
            const endpoint = this.get(namespace, endpointId)
            if (!state.threads[id] && state.projects.some(project => project.id === observed.projectId) && endpoint) {
                // This event has no provenance. Resolve just this selected-project
                // candidate before deciding whether it is ordinary or automatic.
                try { observed = { ...record(record(await endpoint.service.readThread(id)).thread), id } }
                catch { return }
            }
        }
        await this.observeThread(namespace, endpointId, observed, false)
        if (event.method === 'thread/project/updated' && text(params.projectId)) {
            const state = await this.visibility.read(namespace, endpointId)
            const endpoint = this.get(namespace, endpointId)
            if (state.threads[id] && endpoint) {
                const response = record(await endpoint.service.call('project/read', { projectId: params.projectId }))
                await this.observeProject(namespace, endpointId, record(response.project), false)
            }
        }
    }
    async trackCreated(namespace: string, endpointId: string, thread: NativeRecord): Promise<void> {
        const id = text(thread.id)
        if (!id) throw new Error('Native thread creation returned no thread ID')
        this.migrationErrors.delete(JSON.stringify([namespace, endpointId]))
        await this.changeState(namespace, endpointId, state => {
            state.initialized = true
            if (!state.individual.includes(id)) state.individual.push(id)
            state.hidden = state.hidden.filter(value => value !== id)
            const snapshot = { ...state.threads[id], ...directorySnapshot(thread) }
            if (!isDeepStrictEqual(state.threads[id], snapshot)) {
                state.threads[id] = snapshot
                state.threadVersions[id] = (state.threadVersions[id] ?? 0) + 1
            }
        })
    }
    async visibilitySnapshot(namespace: string, endpointId: string): Promise<NativeVisibilityResponse> {
        const endpoint = this.get(namespace, endpointId)
        if (!endpoint) throw new Error('Native endpoint unavailable')
        const state = await this.visibility.read(namespace, endpointId)
        return { visibility: visibilityState(state), sessions: this.summaries(endpoint, state) }
    }
    async changeVisibility(namespace: string, endpointId: string, action: NativeVisibilityAction): Promise<NativeVisibilityResponse> {
        const endpoint = this.get(namespace, endpointId)
        if (!endpoint) throw new Error('Native endpoint unavailable')
        if (action.action === 'track-thread') {
            const response = record(await endpoint.service.readThread(action.threadId))
            const thread: NativeRecord = { ...record(response.thread), id: action.threadId }
            await this.trackCreated(namespace, endpointId, thread)
            if (text(thread.projectId)) {
                const project = record(await endpoint.service.call('project/read', { projectId: thread.projectId }))
                await this.observeProject(namespace, endpointId, record(project.project))
            }
        } else if (action.action === 'hide-thread' || action.action === 'hide-project') {
            await this.changeState(namespace, endpointId, state => {
                state.initialized = true
                if (action.action === 'hide-thread') {
                    if (!state.hidden.includes(action.threadId)) state.hidden.push(action.threadId)
                } else {
                    const removed = new Set([
                        ...(state.projects.find(project => project.id === action.projectId)?.members ?? []),
                        ...Object.entries(state.threads).filter(([, thread]) => thread.projectId === action.projectId ||
                            thread.desktopProjectId === action.projectId || record(thread.desktopProject).id === action.projectId).map(([id]) => id),
                    ])
                    state.individual = state.individual.filter(id => !removed.has(id))
                    state.projects = state.projects.filter(project => project.id !== action.projectId)
                    for (const project of state.projects) project.members = project.members.filter(id => !removed.has(id))
                }
            })
            if (action.action === 'hide-project') this.imports.delete(JSON.stringify([namespace, endpointId, action.projectId]))
        } else {
            const key = JSON.stringify([namespace, endpointId, action.projectId])
            const running = this.imports.get(key)
            if (running) return running
            const work: Promise<NativeVisibilityResponse> = (async () => {
                if (action.action === 'track-project') await this.changeState(namespace, endpointId, state => {
                    state.initialized = true
                    let project = state.projects.find(project => project.id === action.projectId)
                    if (!project) { project = { id: action.projectId, members: [], nextCursor: null, complete: false }; state.projects.push(project) }
                    project.scanMembers = []; project.visitedCursors = []; project.nextCursor = null; project.complete = false; project.scanId = randomUUID()
                })
                return this.importProject(namespace, endpointId, action.projectId, action.action === 'track-project')
            })().finally(() => { if (this.imports.get(key) === work) this.imports.delete(key) })
            this.imports.set(key, work)
            return work
        }
        return this.visibilitySnapshot(namespace, endpointId)
    }
    private async importProject(namespace: string, endpointId: string, projectId: string, select: boolean): Promise<NativeVisibilityResponse> {
        const endpoint = this.get(namespace, endpointId)!
        const eventVersions = this.captureDirectoryEvents(namespace, endpointId, [`project:${projectId}`])
        const previous = await this.visibility.read(namespace, endpointId)
        const project = previous.projects.find(project => project.id === projectId)
        if (!select && !project) throw new Error('Select the native project before discovering its members')
        if (!select && project?.complete) return this.visibilitySnapshot(namespace, endpointId)
        const cursor = select ? undefined : project?.nextCursor ?? undefined
        const page = record(await endpoint.service.call('thread/list', { projectId, limit: 100, archived: false,
            ...(cursor ? { cursor } : {}), sourceKinds: NATIVE_ORDINARY_SOURCE_KINDS, useStateDbOnly: true, sortKey: 'updated_at' }))
        const nextCursor = text(page.nextCursor) ?? null
        if (nextCursor && (nextCursor === cursor || project?.visitedCursors?.includes(nextCursor))) throw new Error('Native project member cursor did not advance')
        const threads = (Array.isArray(page.data) ? page.data : []).map(record).filter(thread => text(thread.id) && !isNativeBackgroundThread(thread))
        let metadata: NativeRecord = {}
        if (select) {
            const response = record(await endpoint.service.call('project/read', { projectId }))
            metadata = record(response.project)
        }
        await this.changeState(namespace, endpointId, state => {
            // A delayed import cannot undo an explicit hide made during its read.
            if (!state.projects.some(project => project.id === projectId)) return
            state.initialized = true
            let current = state.projects.find(project => project.id === projectId)
            if (!current) { current = { id: projectId, members: [], nextCursor: null, complete: false }; state.projects.push(current) }
            if (current.scanId !== project?.scanId) return
            if (text(metadata.name) && (state.projectVersions[projectId] ?? 0) === (previous.projectVersions[projectId] ?? 0)) current.name = text(metadata.name)
            current.nextCursor = nextCursor; current.complete = nextCursor === null
            if (cursor) (current.visitedCursors ??= []).push(cursor)
            for (const thread of threads) {
                const id = String(thread.id)
                if ((state.threadVersions[id] ?? 0) !== (previous.threadVersions[id] ?? 0)) {
                    // A newer move/archive/rename observed during this read wins.
                    if (state.threads[id]?.projectId !== projectId) continue
                } else state.threads[id] = { ...state.threads[id], ...directorySnapshot(thread), projectId }
                if (!current.members.includes(id)) current.members.push(id)
                if (!(current.scanMembers ??= []).includes(id)) current.scanMembers.push(id)
            }
            if (current.complete) { current.members = current.scanMembers ?? current.members; delete current.scanMembers; delete current.visitedCursors }
        })
        if (text(metadata.id)) await this.applyDirectoryReconciliation(namespace, endpointId, { projects: [metadata] }, {
            ...eventVersions,
            [`project:${projectId}`]: previous.projectVersions[projectId] ?? 0,
        })
        return this.visibilitySnapshot(namespace, endpointId)
    }
    private async migrate(namespace: string, endpoint: { config: NativeEndpointConfig; service: NativeService }, legacy: Session[], deadline: number): Promise<void> {
        const endpointId = endpoint.config.id, key = JSON.stringify([namespace, endpointId])
        if ((await this.visibility.read(namespace, endpointId)).initialized || (this.migrationRetryAt.get(key) ?? 0) > Date.now()) return
        const eligible = legacy.some(session => this.alias(session, namespace)?.endpoint.config.id === endpointId)
        if (!eligible) {
            // New hosts/namespaces are empty until explicit import. Upgrade-only
            // discovery requires an already persisted Hub-to-native identity.
            await this.changeState(namespace, endpointId, state => { state.initialized = true })
            return
        }
        const running = this.migrations.get(key)
        if (running) return running
        const work = (async () => {
            try {
                const page = await endpoint.service.catalog({ limit: 100, deadline, boundedMigration: true })
                this.migrationErrors.delete(key)
                await this.changeState(namespace, endpointId, state => {
                    if (state.initialized) return
                    state.initialized = true
                    for (const thread of (Array.isArray(page.data) ? page.data : []).map(record)) {
                        const id = text(thread.id)
                        if (!id) continue
                        state.individual.push(id); state.threads[id] = directorySnapshot(thread)
                    }
                })
            } catch (error) {
                // A temporary offline daemon does not permanently consume migration.
                this.migrationRetryAt.set(key, Date.now() + 60_000)
                this.migrationErrors.set(key, nativeMachineError(error, endpoint.config))
                const aliases = legacy.flatMap(session => {
                    const binding = this.alias(session, namespace)
                    return binding?.endpoint === endpoint ? [{ session, threadId: binding.threadId }] : []
                }).slice(0, 100)
                await this.changeState(namespace, endpointId, state => {
                    if (state.initialized) return
                    for (const { session, threadId } of aliases) {
                        if (!state.individual.includes(threadId)) state.individual.push(threadId)
                        state.threads[threadId] ??= { id: threadId, name: session.metadata?.name, cwd: session.metadata?.path,
                            model: session.model, reasoningEffort: session.modelReasoningEffort, updatedAt: session.updatedAt }
                    }
                })
            }
        })().finally(() => { this.migrations.delete(key) })
        this.migrations.set(key, work)
        return work
    }
    async list(namespace: string, legacy: Session[], options?: {
        endpointId?: string
        cursor?: string
        projectId?: string
        catalog?: string
        limit?: number
    }): Promise<{
        sessions: SessionSummary[]
        nativePagination: Array<{ endpointId: string; nextCursor: string | null; available: boolean; error?: string }>
    }> {
        await this.refresh()
        const endpoints = options?.endpointId ? this.visible(namespace).filter(e => e.config.id === options.endpointId) : this.visible(namespace)
        const summaries = new Map<string, SessionSummary>()
        if (!options?.endpointId) {
            for (const session of legacy) {
                if (!session.metadata?.nativeCodex && !this.alias(session, namespace)) {
                    summaries.set(session.id, toSessionSummary(session))
                }
            }
        }
        const deadline = Date.now() + 5000
        await Promise.all(endpoints.map(endpoint => this.migrate(namespace, endpoint, legacy, deadline)))
        const nativePagination: Array<{ endpointId: string; nextCursor: null; available: boolean; error?: string }> = []
        for (const endpoint of endpoints) {
            const state = await this.visibility.read(namespace, endpoint.config.id)
            for (const summary of this.summaries(endpoint, state)) {
                if (!options?.projectId || summary.metadata?.nativeCodex?.projectId === options.projectId) summaries.set(summary.id, summary)
            }
            const error = this.migrationErrors.get(JSON.stringify([namespace, endpoint.config.id]))
            nativePagination.push({ endpointId: endpoint.config.id, nextCursor: null, available: !error, ...(error ? { error } : {}) })
        }
        return { sessions: [...summaries.values()], nativePagination }
    }
}
