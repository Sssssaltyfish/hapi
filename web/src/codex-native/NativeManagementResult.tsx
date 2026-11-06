import { useState } from 'react'
import type { NativeCommandRequest, NativeCommandResult } from '@hapi/protocol/codexThreadCommands'
import { useTranslation } from '@/lib/use-translation'
import { CodexUsagePanel } from '@/components/CodexUsagePanel'
import type { NativeRecapView } from './useNativeThreadCommands'

type Result = Exclude<NativeCommandResult, { command: 'plan' | 'goal' }>

function actionDescription(action: Record<string, unknown>): string {
    switch (action.type) {
        case 'command': return String(action.command ?? '')
        case 'execve': return [action.program, ...(Array.isArray(action.argv) ? action.argv : [])].join(' ')
        case 'write_stdin': return `${String(action.process_id ?? '')}: ${String(action.stdin ?? '')}`
        case 'apply_patch': return (Array.isArray(action.files) ? action.files : []).join('\n')
        case 'network_access': return `${String(action.protocol ?? '')}://${String(action.host ?? '')}:${String(action.port ?? '')}`
        case 'mcp_tool_call': return `${String(action.server ?? '')} / ${String(action.tool_title ?? action.tool_name ?? '')}`
        case 'request_permissions': return String(action.reason ?? '')
        default: return String(action.type ?? '')
    }
}

export function NativeManagementResult({ result, pending, disabled, execute, dismiss, recaps = [], hideRecap, showRecap, cancelRecap }: {
    result: Result | null
    pending: boolean
    disabled: boolean
    execute: (request: NativeCommandRequest) => Promise<NativeCommandResult>
    dismiss: () => void
    recaps?: readonly NativeRecapView[]
    hideRecap?: (clientId: string) => void
    showRecap?: (clientId: string) => void
    cancelRecap?: (clientId: string) => Promise<void>
}) {
    const { t } = useTranslation()
    const [attempted, setAttempted] = useState<Set<string>>(() => new Set())
    return <>
        {recaps.filter(recap => !recap.hidden && (recap.pending || recap.canceling)).map(recap => <div key={recap.clientId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm text-[var(--app-hint)]">
            <p role="status" className="min-w-0 flex-1">{t(recap.canceling ? 'nativeManagement.recapCanceling' : 'nativeManagement.recapPending')}</p>
            <button type="button" className="min-h-8 px-1 text-xs hover:underline" onClick={() => hideRecap?.(recap.clientId)}>{t('nativeManagement.hideRecap')}</button>
            <button type="button" className="min-h-8 px-1 text-xs hover:underline disabled:opacity-50" aria-label={t('nativeManagement.cancelRecap')}
                disabled={recap.canceling} onClick={() => void cancelRecap?.(recap.clientId)}>{t('button.cancel')}</button>
        </div>)}
        {recaps.filter(recap => recap.hidden).map(recap => <div key={recap.clientId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1 text-xs text-[var(--app-hint)]">
            <button type="button" className="min-h-6 hover:underline" onClick={() => showRecap?.(recap.clientId)}>{t(recap.canceling ? 'nativeManagement.recapCanceling' : recap.ready ? 'nativeManagement.recapAvailable' : 'nativeManagement.recapRunningHidden')}</button>
            {(recap.pending || recap.canceling) && <button type="button" className="min-h-6 px-1 hover:underline disabled:opacity-50" aria-label={t('nativeManagement.cancelRecap')}
                disabled={recap.canceling} onClick={() => void cancelRecap?.(recap.clientId)}>{t('button.cancel')}</button>}
        </div>)}
        {result && <section aria-label={t('nativeManagement.resultLabel')} className="max-h-[min(45vh,24rem)] overflow-y-auto overscroll-contain px-4 py-3">
        <div className="float-right ml-2"><button type="button" aria-label={t('nativeManagement.close')} onClick={dismiss}>×</button></div>
        {result.command === 'compact' && <p className="text-sm" role="status">{t('nativeManagement.compactAccepted')}</p>}
        {result.command === 'recap' && <><p className="text-sm font-medium">{t('nativeManagement.recapTitle')}</p><p className="mt-1 whitespace-pre-wrap text-sm">{result.text}</p></>}
        {result.command === 'usage' && <CodexUsagePanel snapshot={result.snapshot} />}
        {result.command === 'approve' && (result.action === 'retry' ? <p className="text-sm" role="status">{t('nativeManagement.retryAccepted')}</p>
            : result.denial ? <>
                <p className="text-sm font-medium">{t('nativeManagement.deniedAction')}</p>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{actionDescription(result.denial.action)}</pre>
                {result.denial.action.type === 'request_permissions' && <pre className="mt-2 whitespace-pre-wrap break-words text-sm">{JSON.stringify(result.denial.action.permissions, null, 2)}</pre>}
                {typeof result.denial.action.cwd === 'string' && <p className="mt-1 break-all text-xs text-[var(--app-hint)]">{result.denial.action.cwd}</p>}
                {result.denial.rationale && <p className="mt-2 whitespace-pre-wrap text-sm">{result.denial.rationale}</p>}
                <button type="button" className="mt-2 rounded-md bg-[var(--app-secondary-bg)] px-3 py-1.5 text-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-2 focus-visible:outline-[var(--app-link)] disabled:opacity-50"
                    disabled={disabled || pending || attempted.has(result.denial.reviewId)}
                    onClick={() => {
                        const reviewId = result.denial!.reviewId
                        setAttempted(previous => new Set(previous).add(reviewId))
                        void execute({ command: { command: 'approve', action: 'retry', reviewId } }).catch(() => {})
                    }}>{t('nativeManagement.retryOnce')}</button>
            </> : <p className="text-sm">{t('nativeManagement.noDenial')}</p>)}
    </section>}
    </>
}
