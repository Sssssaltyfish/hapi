import { useCallback, useEffect, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { NativeDaemonProject } from '@/codex-native/types'
import { SelectControl } from '@/components/ui/select-control'
import { useTranslation } from '@/lib/use-translation'
import type { NativeWorkspaceCreationDraft } from './newSessionFormDraft'
import { nativeCatalogKey } from '@/codex-native/catalogQueries'

export function useNativeWorkspace(api: ApiClient, endpointId: string, enabled: boolean) {
    const [mode, setMode] = useState<'none' | 'existing' | 'new'>('none')
    const [projectId, setProjectId] = useState('')
    const [name, setName] = useState('')
    const creation = useRef<NativeWorkspaceCreationDraft | null>(null)
    const captureCreationDraft = useCallback(() => creation.current ? { ...creation.current } : undefined, [])
    const restoreCreationDraft = useCallback((draft?: NativeWorkspaceCreationDraft) => { creation.current = draft ? { ...draft } : null }, [])
    const query = useInfiniteQuery({
        queryKey: nativeCatalogKey(api, endpointId, 'projects'),
        queryFn: ({ pageParam, signal }) => api.listCodexNativeProjects(endpointId, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: page => page.nextCursor ?? undefined,
        enabled: enabled && Boolean(endpointId) && mode === 'existing',
        staleTime: 30_000,
        retry: false,
    })
    const projects = query.data?.pages.flatMap(page => page.data) ?? []
    useEffect(() => { setMode('none'); setProjectId(''); setName(''); creation.current = null }, [endpointId])
    async function resolveProjectId(path: string): Promise<string | null> {
        if (mode === 'none') return null
        if (mode === 'existing') {
            if (!projectId) throw new Error('Select a workspace')
            return projectId
        }
        const signature = JSON.stringify([endpointId, name.trim(), path])
        if (creation.current?.signature !== signature) creation.current = { signature, idempotencyKey: crypto.randomUUID() }
        const pending = creation.current
        if (pending.projectId) return pending.projectId
        const result = await api.createCodexNativeProject(endpointId, { name: name.trim(), path, idempotencyKey: pending.idempotencyKey })
        pending.projectId = result.project.id
        return result.project.id
    }
    return { mode, setMode, projectId, setProjectId, name, setName, query, projects, resolveProjectId, captureCreationDraft, restoreCreationDraft, canCreate: mode === 'none' || (mode === 'existing' ? Boolean(projectId) : Boolean(name.trim())) }
}

export function NativeWorkspaceSection(props: { workspace: ReturnType<typeof useNativeWorkspace>; isDisabled: boolean; onSelect: (project: NativeDaemonProject) => void }) {
    const { t } = useTranslation()
    const { workspace } = props
    const className = 'w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm disabled:opacity-50'
    return <div className="flex flex-col gap-2 px-3 py-3">
        <label className="text-xs font-medium text-[var(--app-hint)]" htmlFor="native-workspace-mode">{t('newSession.native.workspace')}</label>
        <SelectControl id="native-workspace-mode" value={workspace.mode} disabled={props.isDisabled} className={className} onChange={event => workspace.setMode(event.target.value as typeof workspace.mode)}>
            <option value="none">{t('newSession.native.noWorkspace')}</option>
            <option value="existing">{t('newSession.native.existingWorkspace')}</option>
            <option value="new">{t('newSession.native.newWorkspace')}</option>
        </SelectControl>
        {workspace.mode === 'existing' ? <>
            <SelectControl aria-label={t('newSession.native.existingWorkspace')} value={workspace.projectId} disabled={props.isDisabled || workspace.query.isPending} className={className} onChange={event => {
                workspace.setProjectId(event.target.value)
                const project = workspace.projects.find(project => project.id === event.target.value)
                if (project) props.onSelect(project)
            }}>
                <option value="" disabled>{t(workspace.query.isPending ? 'loading' : 'newSession.native.selectWorkspace')}</option>
                {workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.roots[0]?.path ? ` · ${project.roots[0].path}` : ''}</option>)}
            </SelectControl>
            {!workspace.query.isPending && workspace.projects.length === 0 && !workspace.query.error ? <p className="text-xs text-[var(--app-hint)]">{t('newSession.native.noWorkspaces')}</p> : null}
            {workspace.query.hasNextPage ? <button type="button" disabled={workspace.query.isFetchingNextPage} onClick={() => void workspace.query.fetchNextPage()} className="self-start text-xs text-[var(--app-link)]">{t('newSession.native.moreWorkspaces')}</button> : null}
        </> : null}
        {workspace.mode === 'new' ? <input aria-label={t('newSession.native.workspaceName')} placeholder={t('newSession.native.workspaceName')} maxLength={200} value={workspace.name} disabled={props.isDisabled} onChange={event => workspace.setName(event.target.value)} className={className} /> : null}
        <p className="text-xs text-[var(--app-hint)]">{t(workspace.mode === 'new' ? 'newSession.native.newWorkspaceHint' : 'newSession.native.workspaceHint')}</p>
        {workspace.mode === 'existing' && workspace.query.error ? <p role="alert" className="text-xs text-red-600">{workspace.query.error.message}</p> : null}
    </div>
}
