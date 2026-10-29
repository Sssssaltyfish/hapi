import { z } from 'zod'
import { toSessionSummary, type Session, type SessionSummary } from '@hapi/protocol'
import { NativeService, nativeConfig, type NativeConfig } from './service'
import { record, text, type NativeRecord } from './transport'

export type NativeEndpointConfig = NativeConfig & {
    id: string
    label: string
    defaultCwd?: string
    allowedRoots?: string[]
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
                ...(text(project.id) ? { projectId: text(project.id), projectName: text(project.name), projectPath: text(project.path) } : {})
            },
            lifecycleState: active ? 'running' : 'idle',
            capabilities: { concurrentClients: true, terminal: false }
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
    constructor(configs = configuredNativeEndpoints(), factory = (config: NativeEndpointConfig) => new NativeService(config)) {
        this.endpoints = configs.map(config => ({ config, service: factory(config) }))
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
            return nativeSession(endpoint.config, { id: threadId }, false, error instanceof Error ? error.message : String(error), legacy)
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
        const endpoints = options?.endpointId ? this.visible(namespace).filter(e => e.config.id === options.endpointId) : this.visible(namespace)
        const summaries = new Map<string, SessionSummary>()
        if (!options?.endpointId) {
            for (const session of legacy) {
                if (!session.metadata?.nativeCodex && !this.alias(session, namespace)) {
                    summaries.set(session.id, toSessionSummary(session))
                }
            }
        }
        const nativePagination = []
        for (const endpoint of endpoints) {
            const aliases = !options?.cursor ? legacy.flatMap(session => {
                const binding = this.alias(session, namespace)
                return binding?.endpoint === endpoint ? [{ session, threadId: binding.threadId }] : []
            }) : []
            let available = true
            let error: string | undefined
            let page: NativeRecord = {}
            try {
                page = await endpoint.service.catalog({
                    limit: options?.limit ?? 100,
                    cursor: options?.cursor,
                    projectId: options?.projectId,
                    catalog: options?.catalog
                })
            } catch (failure) {
                available = false
                error = failure instanceof Error ? failure.message : String(failure)
            }
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
