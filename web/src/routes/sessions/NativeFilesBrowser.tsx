import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { NativeSessionIdentity } from '@/codex-native/session-key'
import { FileIcon } from '@/components/FileIcon'
import { encodeBase64 } from '@/lib/utils'

export function NativeFilesBrowser(props: { api: ApiClient | null; sessionId: string; identity: NativeSessionIdentity }) {
    const navigate = useNavigate()
    const nativeApi = useMemo(() => props.api?.withCodexNativeEndpoint(props.identity.endpointId), [props.api, props.identity.endpointId])
    const thread = useQuery({ queryKey: ['codex-native', props.identity.endpointId, props.identity.threadId, 'thread'], queryFn: () => nativeApi!.getCodexNativeThread(props.identity.threadId), enabled: Boolean(nativeApi) })
    const threadRecord = thread.data?.thread && typeof thread.data.thread === 'object' ? thread.data.thread as Record<string, unknown> : thread.data
    const root = typeof threadRecord?.cwd === 'string' ? threadRecord.cwd : ''
    const [chosenPath, setChosenPath] = useState('')
    const [draft, setDraft] = useState<string | null>(null)
    const path = chosenPath || root
    const directory = useQuery({
        queryKey: ['codex-native', props.identity.endpointId, props.identity.threadId, 'directory', path],
        queryFn: () => props.api!.readCodexNativeDirectory(props.identity.endpointId, props.identity.threadId, path),
        enabled: Boolean(props.api && path),
    })
    const entries = useMemo(() => [...(directory.data?.entries ?? [])].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName)), [directory.data])
    const parent = path.replace(/[/\\]+$/, '').replace(/[/\\][^/\\]+$/, '') || '/'
    function select(fileName: string, isDirectory: boolean) {
        const fullPath = `${path.replace(/[/\\]+$/, '')}/${fileName}`
        if (isDirectory) { setChosenPath(fullPath); setDraft(null); return }
        void navigate({ to: '/sessions/$sessionId/file', params: { sessionId: props.sessionId }, search: { path: encodeBase64(fullPath), tab: 'directories' } })
    }
    const error = directory.error ?? thread.error
    return <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--app-border)] p-3">
            <button type="button" onClick={() => void navigate({ to: '/sessions/$sessionId', params: { sessionId: props.sessionId } })} className="rounded px-2 py-1 text-sm hover:bg-[var(--app-subtle-bg)]">←</button>
            <span className="min-w-0 flex-1 truncate font-semibold">Files</span>
            <button type="button" aria-label="Refresh files" onClick={() => void directory.refetch()} className="rounded px-2 py-1 text-sm hover:bg-[var(--app-subtle-bg)]">↻</button>
        </div>
        <form className="flex gap-2 border-b border-[var(--app-divider)] p-3" onSubmit={(event) => { event.preventDefault(); const next = (draft ?? path).trim(); if (next) { setChosenPath(next); setDraft(null) } }}>
            <input aria-label="Directory path" className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm" value={draft ?? path} onChange={(event) => setDraft(event.target.value)} />
            <button type="submit" className="rounded-md bg-[var(--app-subtle-bg)] px-3 text-sm">Open</button>
        </form>
        <div className="app-scroll-y min-h-0 flex-1">
            {path && path !== root ? <button className="w-full border-b border-[var(--app-divider)] px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)]" onClick={() => { setChosenPath(parent); setDraft(null) }}>↰ ..</button> : null}
            {error ? <p role="alert" className="p-3 text-sm text-red-600">{error.message}</p> : thread.isPending || directory.isPending ? <p className="p-3 text-sm text-[var(--app-hint)]">Loading files…</p> : entries.length === 0 ? <p className="p-3 text-sm text-[var(--app-hint)]">This directory is empty.</p> : entries.map((entry) => <button type="button" key={entry.fileName} disabled={!entry.isDirectory && !entry.isFile} onClick={() => select(entry.fileName, entry.isDirectory)} className="flex w-full items-center gap-3 border-b border-[var(--app-divider)] px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)]">
                {entry.isDirectory ? <span aria-hidden="true" className="text-[var(--app-link)]">📁</span> : <FileIcon fileName={entry.fileName} size={22} />}
                <span className="truncate text-sm">{entry.fileName}</span>
            </button>)}
        </div>
    </div>
}
