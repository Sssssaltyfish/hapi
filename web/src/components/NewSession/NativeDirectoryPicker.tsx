import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'

/** Browsing stays in the launch form and always addresses the selected machine. */
export function NativeDirectoryPicker(props: { api: ApiClient; endpointId: string; initialPath: string; onSelect: (path: string) => void; onClose: () => void }) {
    const { t } = useTranslation()
    const [path, setPath] = useState(props.initialPath)
    const [draft, setDraft] = useState(props.initialPath)
    const [includeHidden, setIncludeHidden] = useState(false)
    const directory = useQuery({
        queryKey: ['codex-native', props.endpointId, 'directory', path, includeHidden],
        queryFn: () => props.api.listCodexNativeDirectory(props.endpointId, path, includeHidden),
        retry: false,
    })
    function browse(next: string) { setPath(next); setDraft(next) }
    const buttonClass = 'rounded-md border border-[var(--app-border)] px-2 py-1.5 text-xs disabled:opacity-50'
    return <div role="region" aria-label={t('browse.title')} className="mx-3 mb-3 space-y-2 rounded-md border border-[var(--app-border)] p-3">
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setPath(draft.trim()) }}>
            <input aria-label={t('newSession.directory')} value={draft} onChange={event => setDraft(event.target.value)} className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm" />
            <button className={buttonClass} type="submit">{t('newSession.browse')}</button>
        </form>
        {directory.data ? <>
            <div className="break-all text-xs text-[var(--app-hint)]">{directory.data.path}</div>
            <button type="button" className={buttonClass} disabled={directory.data.path === directory.data.parentPath} onClick={() => browse(directory.data!.parentPath)}>↑ {t('browse.goUp')}</button>
            <div className="max-h-52 overflow-y-auto">
                {directory.data.entries.map(entry => <button key={entry.path} type="button" onClick={() => browse(entry.path)} className="block w-full truncate rounded px-2 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)]" title={entry.path}>📁 {entry.fileName}</button>)}
                {!directory.data.entries.length ? <p className="py-2 text-xs text-[var(--app-hint)]">{t('browse.empty')}</p> : null}
            </div>
            {directory.data.truncated ? <p className="text-xs text-[var(--app-hint)]">{t('newSession.native.directoryTruncated')}</p> : null}
        </> : null}
        {directory.isFetching ? <p role="status" className="text-xs">{t('loading')}</p> : null}
        {directory.error ? <p role="alert" className="text-xs text-red-600">{directory.error.message}</p> : null}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeHidden} onChange={event => setIncludeHidden(event.target.checked)} />{t('browse.showHidden')}</label>
        <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} onClick={props.onClose}>{t('button.cancel')}</button>
            <button type="button" className={`${buttonClass} text-[var(--app-link)]`} disabled={!directory.data || directory.isFetching} onClick={() => { if (directory.data) props.onSelect(directory.data.path) }}>{t('newSession.native.selectDirectory')}</button>
        </div>
    </div>
}
