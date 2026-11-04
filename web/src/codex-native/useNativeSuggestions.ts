import { useCallback, useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { Suggestion } from '@/hooks/useActiveSuggestions'

/** Reuse the existing suggestion UI and quoted path grammar. Superseded searches
 * cannot publish stale suggestions when a user types or changes conversations. */
export function useNativeSuggestions(api: ApiClient, threadId: string) {
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
                return controller.signal.aborted ? [] : response.suggestions
            } catch (error) {
                if (controller.signal.aborted) return []
                throw error
            }
        },
        [api, threadId]
    )
}
