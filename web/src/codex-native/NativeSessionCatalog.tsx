import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse } from '@/types/api'
import type { NativeEvent } from './types'
import type { NativeVisibilityState } from '@hapi/protocol/codexNativeVisibility'
import { isNativeBackgroundThread } from '@hapi/protocol/codexNativeVisibility'
import { nativeCatalogKey } from './catalogQueries'
import { queryKeys } from '@/lib/query-keys'

/** Observe metadata changes; the home list itself contains every tracked row. */
export function NativeSessionCatalog({ api }: { api: ApiClient; onSelect?: (id: string) => void; selectedId?: string | null }) {
    const client = useQueryClient()
    const endpoints = useQuery({ queryKey: ['codex-native', 'endpoints'], queryFn: () => api.getCodexNativeEndpoints(), staleTime: 30_000, retry: false })
    const endpointIds = endpoints.data?.endpoints.map(endpoint => endpoint.id).join('\0') ?? ''
    useEffect(() => {
        const controller = new AbortController()
        const retries = new Set<ReturnType<typeof setTimeout>>()
        const refreshes = new Map<string, ReturnType<typeof setTimeout>>()
        const attempts = new Map<string, number>()
        const changed = (endpointId: string, event: NativeEvent) => {
            if (controller.signal.aborted) return
            const { method } = event, params = event.params ?? {}
            if (method === 'hapi/catalogReady') attempts.set(endpointId, 0)
            if (!['hapi/catalogReady', 'hapi/catalogReconciled', 'hapi/visibility/updated', 'project/changed', 'thread/project/updated', 'thread/started', 'thread/name/updated', 'thread/status/changed', 'thread/archived', 'thread/unarchived', 'thread/deleted'].includes(method)) return
            const thread = params.thread as Record<string, unknown> | undefined
            const threadId = typeof params.threadId === 'string' ? params.threadId : typeof thread?.id === 'string' ? thread.id : undefined
            const sessions = client.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions ?? []
            const known = threadId && sessions.some(session => session.metadata?.nativeCodex?.endpointId === endpointId && session.metadata.nativeCodex.threadId === threadId)
            const visibility = client.getQueryData<NativeVisibilityState>(nativeCatalogKey(api, endpointId, 'visibility'))
            const projectId = params.projectId ?? thread?.projectId
            const selectedProject = typeof projectId === 'string' && visibility?.projects.some(project => project.id === projectId)
            const home = ['hapi/catalogReady', 'hapi/catalogReconciled', 'hapi/visibility/updated', 'project/changed'].includes(method) || Boolean(known) || Boolean(selectedProject)
            const catalog = method !== 'thread/status/changed'
            if (!home && !catalog) return
            const key = `${endpointId}:${method}:${threadId ?? projectId ?? ''}`
            clearTimeout(refreshes.get(key))
            refreshes.set(key, setTimeout(() => {
                refreshes.delete(key)
                if (home) void client.invalidateQueries({ queryKey: queryKeys.sessions })
                if (catalog) void client.invalidateQueries({ queryKey: nativeCatalogKey(api, endpointId), predicate: query => {
                    if (['hapi/catalogReady', 'hapi/catalogReconciled', 'hapi/visibility/updated', 'project/changed'].includes(method)) return true
                    if (query.queryKey[3] === 'visibility') return Boolean(known)
                    if (query.queryKey[3] !== 'members') return false
                    if (method === 'thread/project/updated' || method === 'thread/unarchived') return true
                    if (method === 'thread/started') {
                        if (thread && isNativeBackgroundThread(thread)) return query.queryKey[4] === 'background'
                        return projectId === undefined || query.queryKey[4] === (projectId || 'projectless')
                    }
                    const data = query.state.data as { pages?: Array<{ data?: Array<{ id?: string }> }> } | undefined
                    return Boolean(threadId && data?.pages?.some(page => page.data?.some(thread => thread.id === threadId)))
                } })
            }, 100))
        }
        const connect = async (endpointId: string) => {
            try { await api.streamCodexNativeCatalog(endpointId, controller.signal, event => changed(endpointId, event)) }
            catch { /* A disconnected endpoint remains in the tracked home snapshot. */ }
            if (controller.signal.aborted) return
            const attempt = attempts.get(endpointId) ?? 0
            attempts.set(endpointId, attempt + 1)
            const retry = setTimeout(() => { retries.delete(retry); void connect(endpointId) }, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)))
            retries.add(retry)
        }
        if (typeof api.streamCodexNativeCatalog === 'function') for (const id of endpointIds.split('\0').filter(Boolean)) void connect(id)
        return () => { controller.abort(); for (const timer of refreshes.values()) clearTimeout(timer); for (const timer of retries) clearTimeout(timer) }
    }, [api, endpointIds, client])
    return null
}
