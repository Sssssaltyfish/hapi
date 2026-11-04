import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SelectControl } from '@/components/ui/select-control'
import { Button } from '@/components/ui/button'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { nativeCatalogKey, refreshNativeCatalog } from './catalogQueries'

export function NativeProjectActions({ api, endpointId, projectId, name }: { api: ApiClient; endpointId: string; projectId: string; name: string }) {
    const { t } = useTranslation()
    const client = useQueryClient()
    const [menu, setMenu] = useState(false)
    const [dialog, setDialog] = useState<'rename' | 'hide' | null>(null)
    const [busy, setBusy] = useState(false)
    const hide = async () => {
        setBusy(true)
        try { await api.updateCodexNativeVisibility(endpointId, { action: 'hide-project', projectId }); await refreshNativeCatalog(client, api, [endpointId]) }
        finally { setBusy(false) }
    }
    return <span className="contents" onClick={event => event.stopPropagation()}>
        <Popover.Root open={menu} onOpenChange={setMenu}>
            <Popover.Trigger asChild><button type="button" data-testid={`native-project-actions-${projectId}`} aria-label={t('native.catalog.projectActions', { name })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]" onClick={event => event.stopPropagation()}>⋯</button></Popover.Trigger>
            <Popover.Portal><Popover.Content align="end" sideOffset={4} className="z-50 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg" onClick={event => event.stopPropagation()}>
                <button type="button" className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)]" onClick={() => { setMenu(false); setDialog('rename') }}>{t('native.catalog.renameProject')}</button>
                <button type="button" className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)]" onClick={() => { setMenu(false); setDialog('hide') }}>{t('native.catalog.hide')}</button>
            </Popover.Content></Popover.Portal>
        </Popover.Root>
        {dialog === 'hide' ? <ConfirmDialog isOpen onClose={() => setDialog(null)} title={t('native.catalog.hideProjectTitle')} description={t('native.catalog.hideProjectDescription', { name })} confirmLabel={t('native.catalog.hide')} confirmingLabel={t('native.catalog.hiding')} isPending={busy} onConfirm={hide} /> : null}
        {dialog === 'rename' ? <RenameSessionDialog isOpen onClose={() => setDialog(null)} title={t('native.catalog.renameProject')} placeholder={t('newSession.native.workspaceName')} currentName={name} isPending={busy} onRename={async value => {
            setBusy(true)
            try { await api.renameCodexNativeProject(endpointId, projectId, value); await refreshNativeCatalog(client, api, [endpointId]) }
            finally { setBusy(false) }
        }} /> : null}
    </span>
}

export function NativeThreadDialogs({ api, session, mode, onClose }: { api: ApiClient; session: SessionSummary; mode: 'hide' | 'move'; onClose: () => void }) {
    const { t } = useTranslation()
    const client = useQueryClient()
    const native = session.metadata!.nativeCodex!
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [projectId, setProjectId] = useState(native.projectId ?? '')
    const projects = useInfiniteQuery({
        queryKey: nativeCatalogKey(api, native.endpointId, 'projects'),
        queryFn: ({ pageParam, signal }) => api.listCodexNativeProjects(native.endpointId, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: page => page.nextCursor ?? undefined,
        enabled: mode === 'move', retry: false, staleTime: 30_000,
    })
    const rows = [...new Map((projects.data?.pages.flatMap(page => page.data) ?? []).map(project => [project.id, project])).values()]
    const hide = async () => {
        setBusy(true)
        try { await api.updateCodexNativeVisibility(native.endpointId, { action: 'hide-thread', threadId: native.threadId }); await refreshNativeCatalog(client, api, [native.endpointId]) }
        finally { setBusy(false) }
    }
    if (mode === 'hide') return <ConfirmDialog isOpen onClose={onClose} title={t('native.catalog.hideThreadTitle')} description={t('native.catalog.hideThreadDescription')} confirmLabel={t('native.catalog.hide')} confirmingLabel={t('native.catalog.hiding')} isPending={busy} onConfirm={hide} />
    const move = async () => {
        setBusy(true); setError('')
        try { await api.moveCodexNativeThread(native.endpointId, native.threadId, projectId || null); await refreshNativeCatalog(client, api, [native.endpointId]); onClose() }
        catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
    }
    return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t('native.catalog.move')}</DialogTitle></DialogHeader>
        <SelectControl aria-label={t('newSession.native.workspace')} value={projectId} disabled={busy || projects.isPending} className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm" onChange={event => setProjectId(event.target.value)}>
            <option value="">{t('newSession.native.noWorkspace')}</option>
            {native.projectId && !rows.some(project => project.id === native.projectId) ? <option value={native.projectId}>{native.projectName ?? native.projectId}</option> : null}
            {rows.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </SelectControl>
        {projects.hasNextPage ? <button type="button" className="text-left text-xs text-[var(--app-link)]" disabled={busy || projects.isFetchingNextPage} onClick={() => void projects.fetchNextPage()}>{t('newSession.native.moreWorkspaces')}</button> : null}
        {projects.error || error ? <p role="alert" className="text-xs text-red-600">{error || projects.error?.message} {projects.error ? <button type="button" className="underline" onClick={() => void projects.refetch()}>{t('button.retry')}</button> : null}</p> : null}
        <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={onClose}>{t('button.cancel')}</Button><Button disabled={busy || projectId === (native.projectId ?? '')} onClick={() => void move()}>{t('native.catalog.move')}</Button></div>
    </DialogContent></Dialog>
}
