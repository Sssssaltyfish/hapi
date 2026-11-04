import { z } from 'zod'
import { toSessionSummary, type Session, type SessionSummary } from '@hapi/protocol'
import { NativeService, nativeConfig, type NativeConfig } from './service'
import { record, text, type NativeRecord } from './transport'
import { NativeMachineSettings, nativeDisplayAddress, nativeMachineError, type NewNativeEndpoint } from './machineSettings'

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
                ...(text(project.id) ? { projectId: text(project.id), projectName: text(project.name), projectPath: text(project.path) }
                    : thread.desktopProject === undefined && text(thread.projectId) ? { projectId: text(thread.projectId) } : {})
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

    constructor(
        private readonly configs = configuredNativeEndpoints(),
        private readonly factory = (config: NativeEndpointConfig) => new NativeService(config),
        options?: { dataDir: string }
    ) {
        this.endpoints = configs.map(config => ({ config, service: factory(config) }))
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
    }

    summary(config: NativeEndpointConfig) {
        return {
            id: config.id,
            label: config.label,
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
            return nativeSession(endpoint.config, { ...record(response.thread), id: threadId }, true, undefined, legacy)
        } catch (error) {
            return nativeSession(endpoint.config, { id: threadId }, false, nativeMachineError(error, endpoint.config), legacy)
        }
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
        const deadline = Date.now() + 5_000
        // Configuration is capped at 16 connections. Start every configured machine
        // within the shared budget so stalled connections cannot starve later ones.
        const results = await Promise.all(endpoints.map(async (endpoint): Promise<{
            page: NativeRecord
            available: boolean
            error?: string
        }> => {
            if (Date.now() >= deadline) {
                return { page: {}, available: false, error: 'Native catalog request timed out' }
            }
            try {
                const page = await endpoint.service.catalog({
                    limit: options?.limit ?? 100,
                    cursor: options?.cursor,
                    projectId: options?.projectId,
                    catalog: options?.catalog,
                    deadline
                })
                return { page, available: true }
            } catch (failure) {
                return {
                    page: {},
                    available: false,
                    error: nativeMachineError(failure, endpoint.config)
                }
            }
        }))
        const nativePagination = []
        for (const [index, endpoint] of endpoints.entries()) {
            const aliases = !options?.cursor ? legacy.flatMap(session => {
                const binding = this.alias(session, namespace)
                return binding?.endpoint === endpoint ? [{ session, threadId: binding.threadId }] : []
            }) : []
            const { page, available, error } = results[index]
            for (const thread of Array.isArray(page.data) ? page.data.map(record) : []) {
                const alias = aliases.find(alias => alias.threadId === thread.id)
                const session = nativeSession(endpoint.config, thread, true, undefined, alias?.session)
                summaries.set(session.id, toSessionSummary(session))
            }
            nativePagination.push({ endpointId: endpoint.config.id, nextCursor: text(page.nextCursor) ?? null, available, ...(error ? { error } : {}) })
        }
        return { sessions: [...summaries.values()], nativePagination }
    }
}
