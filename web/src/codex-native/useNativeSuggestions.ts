import { useCallback, useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { SessionSummary } from '@/types/api'
import type { NativeEndpoint } from './types'
import { matchSessionsForMention } from '@/lib/sessionReference'
import { getSessionTitle } from '@/lib/sessionTitle'
import { serializeComposerSegments } from '@/lib/composerSegments'

/** Reuse the existing suggestion UI and quoted path grammar. Superseded searches
 * cannot publish stale suggestions when a user types or changes conversations. */
export function useNativeSuggestions(api: ApiClient, threadId: string, context?: {
    endpointId: string
    sessions: readonly SessionSummary[]
    endpoints: readonly NativeEndpoint[]
}) {
    const pending = useRef<AbortController | null>(null)
    useEffect(() => () => pending.current?.abort(), [api, threadId])
    return useCallback(
        async (query: string): Promise<Suggestion[]> => {
            pending.current?.abort()
            const controller = new AbortController()
            pending.current = controller
            if (!query.startsWith('@') && !query.startsWith('$')) return []
            try {
                const response = await api.getCodexNativeSuggestions(
                    threadId,
                    query,
                    controller.signal
                )
                if (controller.signal.aborted) return []
                if (!query.startsWith('@') || !context || response.canReferenceThreads !== true) return response.suggestions
                const hosts = new Map<string, number>()
                for (const endpoint of context.endpoints) if (endpoint.desktopHostId) hosts.set(endpoint.desktopHostId, (hosts.get(endpoint.desktopHostId) ?? 0) + 1)
                const mapped = new Map(context.endpoints.filter(endpoint => endpoint.desktopHostId
                    && /^[a-zA-Z0-9._:-]+$/.test(endpoint.desktopHostId) && hosts.get(endpoint.desktopHostId) === 1)
                    .map(endpoint => [endpoint.id, endpoint]))
                const candidates = context.sessions.filter(session => {
                    const native = session.metadata?.nativeCodex
                    return native && native.available !== false && mapped.has(native.endpointId)
                        && !(native.threadId === threadId && native.endpointId === context.endpointId)
                })
                const threads: Suggestion[] = matchSessionsForMention(candidates, query.slice(1), { limit: 60 }).map(session => {
                    const title = getSessionTitle(session)
                    const endpoint = mapped.get(session.metadata!.nativeCodex!.endpointId)!
                    return {
                        key: `session:${session.id}`, group: 'threads', label: `@${title}`,
                        text: serializeComposerSegments([{ type: 'session', id: session.id, title }]),
                        description: endpoint.displayName || endpoint.label,
                        sessionMention: { id: session.id, title },
                    }
                })
                return [...threads, ...response.suggestions]
            } catch (error) {
                if (controller.signal.aborted) return []
                throw error
            }
        },
        [api, threadId, context?.endpointId, context?.sessions, context?.endpoints]
    )
}
