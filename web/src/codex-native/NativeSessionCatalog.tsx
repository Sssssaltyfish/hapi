import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { SessionItem } from '@/components/SessionList'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { useSessionLastSeenVersion } from '@/lib/sessionLastSeen'

/** Reuses the existing list rows. These requests retrieve metadata only. */
export function NativeSessionCatalog({ api, onSelect, selectedId }: { api: ApiClient; onSelect: (id: string) => void; selectedId: string | null }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const lastSeenVersion = useSessionLastSeenVersion()
    const endpoints = useQuery({ queryKey: ['codex-native', 'endpoints'], queryFn: () => api.getCodexNativeEndpoints(), staleTime: 30_000, retry: false })
    const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: () => api.getSessions(), enabled: false })
    const [open, setOpen] = useState(false)
    const [rows, setRows] = useState<SessionSummary[]>([])
    const [cursors, setCursors] = useState<Record<string, string | null>>({})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const load = async (endpointId: string, catalog?: 'background', cursor?: string) => {
        setBusy(true)
        setError('')
        try {
            const page = await api.getSessions({ nativeEndpointId: endpointId, nativeCursor: cursor, nativeCatalog: catalog })
            if (catalog) {
                setRows(current => [...new Map([...current, ...page.sessions].map(session => [session.id, session])).values()].slice(-300))
                setCursors(current => ({ ...current, [endpointId]: page.nativePagination?.find(value => value.endpointId === endpointId)?.nextCursor ?? null }))
            } else {
                queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, current => ({
                    sessions: [...new Map([...(current?.sessions ?? []), ...page.sessions].map(session => [session.id, session])).values()],
                    nativePagination: [...(current?.nativePagination ?? []).filter(value => value.endpointId !== endpointId), ...(page.nativePagination ?? [])]
                }))
            }
        } catch (error) { setError(String(error)) } finally { setBusy(false) }
    }
    if (!endpoints.data?.endpoints.length) return null
    return <div className="mt-2 border-t border-[var(--app-border)] pt-2">
        {sessions.data?.nativePagination?.filter(page => page.nextCursor).map(page => <button key={page.endpointId} type="button" disabled={busy}
            className="my-1 w-full rounded-md border border-dashed border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-hint)] disabled:opacity-50"
            onClick={() => void load(page.endpointId, undefined, page.nextCursor!)}>{t('native.moreConversations')}</button>)}
        <details open={open} onToggle={event => {
            const expanded = event.currentTarget.open
            setOpen(expanded)
            if (expanded && !rows.length && !busy) for (const endpoint of endpoints.data.endpoints) void load(endpoint.id, 'background')
        }}>
            <summary className="cursor-pointer rounded-lg px-2 py-1.5 text-sm text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]">{t('native.backgroundCatalog')}</summary>
            {open && <div className="ml-3 space-y-1">
                {rows.map(session => <SessionItem key={session.id} session={session} api={api} onSelect={onSelect} selected={session.id === selectedId} lastSeenVersion={lastSeenVersion} />)}
                {Object.entries(cursors).filter(([, cursor]) => cursor).map(([endpointId, cursor]) => <button key={endpointId} type="button" disabled={busy}
                    className="w-full rounded-md border border-dashed border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-hint)] disabled:opacity-50"
                    onClick={() => void load(endpointId, 'background', cursor!)}>{t('native.moreConversations')}</button>)}
                {busy && <p className="px-2 text-xs text-[var(--app-hint)]">{t('loading')}</p>}
            </div>}
        </details>
        {error && <p role="alert" className="px-2 text-xs text-red-600">{error}</p>}
    </div>
}
