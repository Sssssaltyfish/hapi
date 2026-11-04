import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { NativeVisibilityState } from '@hapi/protocol/codexNativeVisibility'
import type { NativeDaemonProject, NativeEndpoint, NativeRecord } from './types'
import { nativeCatalogKey, refreshNativeCatalog } from './catalogQueries'
import { importNativeSelection, isNativeBackgroundThread, nativeImportSelectionKey, nativeImportTitle, type NativeImportSelection } from './nativeImport'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { NativeProjectActions } from './NativeCatalogActions'

type TreeSelection = {
    selected: ReadonlyMap<string, NativeImportSelection>
    toggle: (selection: NativeImportSelection) => void
    busy: boolean
}
const rowClass = 'flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm'

function ImportMembers({ api, endpointId, projectId, name, visibility, selection, background = false }: {
    api: ApiClient; endpointId: string; projectId: string | null; name: string; visibility?: NativeVisibilityState; selection: TreeSelection; background?: boolean
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const parent: NativeImportSelection = { endpointId, kind: background ? 'background' : projectId === null ? 'projectless' : 'project', id: projectId ?? '', name }
    const whole = selection.selected.has(nativeImportSelectionKey(parent))
    const query = useInfiniteQuery({
        queryKey: nativeCatalogKey(api, endpointId, 'members', background ? 'background' : projectId ?? 'projectless'),
        queryFn: async ({ pageParam, signal }) => {
            const page = background ? await api.listCodexNativeBackgroundThreads(endpointId, pageParam, signal) : await api.listCodexNativeProjectThreads(endpointId, projectId, pageParam, signal)
            if (pageParam && page.nextCursor === pageParam) throw new Error('This page did not advance. Retry to continue.')
            return page
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: page => page.nextCursor ?? undefined,
        enabled: open,
        staleTime: 30_000,
        retry: false,
    })
    const rows = [...new Map((query.data?.pages.flatMap(page => page.data) ?? []).filter(thread => typeof thread.id === 'string').map(thread => [thread.id as string, thread])).values()]
    const visible = background ? rows : rows.filter(thread => !isNativeBackgroundThread(thread))
    const renderThread = (thread: NativeRecord) => {
        const id = String(thread.id), title = nativeImportTitle(thread)
        const item: NativeImportSelection = { endpointId, kind: 'thread', id, name: title }
        const explicit = selection.selected.has(nativeImportSelectionKey(item))
        const hidden = visibility?.hiddenThreadIds.includes(id) ?? false
        const added = visibility?.threadIds.includes(id) ?? false
        return <label key={id} className="flex min-w-0 items-center gap-2 py-1.5 text-sm">
            <input type="checkbox" data-testid={`native-import-thread-${id}`} aria-label={t('native.import.selectThread', { name: title })}
                checked={explicit || (whole && !hidden)} disabled={selection.busy || (whole && !hidden)} onChange={() => selection.toggle(item)} />
            <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
            {added ? <span className="shrink-0 text-xs text-[var(--app-hint)]">{t('native.import.added')}</span> : null}
        </label>
    }
    return <div className="min-w-0">
        <div className="flex items-center gap-2">
            <input type="checkbox" checked={whole} disabled={selection.busy} aria-label={t('native.import.selectProject', { name })} onChange={() => selection.toggle(parent)} />
            <button type="button" className={rowClass} aria-expanded={open} data-testid={background ? `native-import-background-${endpointId}` : projectId === null ? `native-import-projectless-${endpointId}` : `native-import-project-${endpointId}-${projectId}`} onClick={() => setOpen(!open)}>
                <span aria-hidden="true">{open ? '▾' : '▸'}</span><span className="truncate">{name}</span>
            </button>
            {projectId && visibility?.projects.some(project => project.id === projectId) ? <NativeProjectActions api={api} endpointId={endpointId} projectId={projectId} name={name} /> : null}
        </div>
        {open ? <div className="ml-5 border-l border-[var(--app-divider)] pl-3">
            {query.isPending ? <p className="py-2 text-xs text-[var(--app-hint)]">{t('loading')}</p> : null}
            {visible.map(renderThread)}
            {!query.isPending && rows.length === 0 && !query.hasNextPage && !query.error ? <p className="py-2 text-xs text-[var(--app-hint)]">{t('native.import.empty')}</p> : null}
            {query.hasNextPage ? <button type="button" className="py-2 text-xs text-[var(--app-link)]" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('native.import.more')}</button> : null}
            {query.error ? <p role="alert" className="py-2 text-xs text-red-600">{query.error.message} <button type="button" className="underline" onClick={() => void (query.hasNextPage ? query.fetchNextPage() : query.refetch())}>{t('button.retry')}</button></p> : null}
        </div> : null}
    </div>
}

function ImportEndpoint({ api, endpoint, selection }: { api: ApiClient; endpoint: NativeEndpoint; selection: TreeSelection }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const projects = useInfiniteQuery({
        queryKey: nativeCatalogKey(api, endpoint.id, 'projects'),
        queryFn: async ({ pageParam, signal }) => {
            const page = await api.listCodexNativeProjects(endpoint.id, pageParam, signal)
            if (pageParam && page.nextCursor === pageParam) throw new Error('This page did not advance. Retry to continue.')
            return page
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: page => page.nextCursor ?? undefined,
        enabled: open,
        staleTime: 30_000,
        retry: false,
    })
    const visibility = useQuery({ queryKey: nativeCatalogKey(api, endpoint.id, 'visibility'), queryFn: ({ signal }) => api.getCodexNativeVisibility(endpoint.id, signal), enabled: open, staleTime: 0, retry: false })
    const rows = [...new Map<string, NativeDaemonProject>([
        ...(visibility.data?.projects ?? []).map(project => [project.id, { id: project.id, name: project.name ?? project.id, roots: [] as NativeDaemonProject['roots'] }] as const),
        ...(projects.data?.pages.flatMap(page => page.data) ?? []).map(project => [project.id, project] as const),
    ]).values()]
    return <div className="min-w-0">
        <button type="button" className={`${rowClass} w-full font-medium`} aria-expanded={open} data-testid={`native-import-endpoint-${endpoint.id}`} onClick={() => setOpen(!open)}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>{endpoint.label}
        </button>
        {open ? <div className="ml-3 pl-2">
            {rows.map(project => <ImportMembers key={project.id} api={api} endpointId={endpoint.id} projectId={project.id} name={project.name} visibility={visibility.data} selection={selection} />)}
            <ImportMembers api={api} endpointId={endpoint.id} projectId={null} name={t('newSession.native.noWorkspace')} visibility={visibility.data} selection={selection} />
            {projects.isPending ? <p className="py-2 text-xs text-[var(--app-hint)]">{t('loading')}</p> : null}
            {projects.hasNextPage ? <button type="button" className="py-2 text-xs text-[var(--app-link)]" disabled={projects.isFetchingNextPage} onClick={() => void projects.fetchNextPage()}>{t('newSession.native.moreWorkspaces')}</button> : null}
            {projects.error || visibility.error ? <p role="alert" className="py-2 text-xs text-red-600">{projects.error?.message ?? visibility.error?.message} <button type="button" className="underline" onClick={() => { void projects.refetch(); void visibility.refetch() }}>{t('button.retry')}</button></p> : null}
            <ImportMembers api={api} endpointId={endpoint.id} projectId={null} name={t('native.import.background')} visibility={visibility.data} selection={selection} background />
        </div> : null}
    </div>
}

export function NativeImportTree({ api, endpoints }: { api: ApiClient; endpoints: NativeEndpoint[] }) {
    const { t } = useTranslation()
    const client = useQueryClient()
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState<Map<string, NativeImportSelection>>(new Map())
    const [busy, setBusy] = useState(false)
    const [progress, setProgress] = useState(0)
    const [message, setMessage] = useState('')
    const [error, setError] = useState('')
    const stopped = useRef(false), alive = useRef(true)
    useEffect(() => { alive.current = true; return () => { alive.current = false; stopped.current = true } }, [])
    const toggle = (selection: NativeImportSelection) => setSelected(current => {
        const next = new Map(current), key = nativeImportSelectionKey(selection)
        if (next.has(key)) next.delete(key); else next.set(key, selection)
        return next
    })
    const run = async () => {
        stopped.current = false; setBusy(true); setError(''); setMessage(''); setProgress(0)
        try {
            const complete = await importNativeSelection(api, [...selected.values()], () => stopped.current, count => { if (alive.current) setProgress(count) })
            if (alive.current) { setMessage(t(complete ? 'native.import.complete' : 'native.import.cancelled')); if (complete) setSelected(new Map()) }
        } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)) }
        finally { await refreshNativeCatalog(client, api, [...new Set([...selected.values()].map(item => item.endpointId))]); if (alive.current) setBusy(false) }
    }
    return <section className="px-3 py-3">
        <button type="button" data-testid="native-import-toggle" aria-expanded={open} className="text-sm text-[var(--app-link)]" onClick={() => { if (open) stopped.current = true; setOpen(!open) }}>{t('native.import.title')}</button>
        {open ? <div data-testid="native-import-tree" className="mt-2 space-y-2">
            {endpoints.map(endpoint => <ImportEndpoint key={endpoint.id} api={api} endpoint={endpoint} selection={{ selected, toggle, busy }} />)}
            {!endpoints.length ? <p className="text-xs text-[var(--app-hint)]">{t('native.import.noEndpoints')}</p> : null}
            <div className="flex items-center gap-3">
                <Button type="button" disabled={busy || selected.size === 0} onClick={() => void run()}>{t('native.import.selected', { count: selected.size })}</Button>
                {busy ? <button type="button" className="text-sm text-[var(--app-link)]" onClick={() => { stopped.current = true }}>{t('button.cancel')}</button> : null}
            </div>
            {busy ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('native.import.progress', { count: progress })}</p> : null}
            {message ? <p role="status" className="text-xs text-[var(--app-hint)]">{message}</p> : null}
            {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
        </div> : null}
    </section>
}
