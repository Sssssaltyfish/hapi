import { useState } from 'react'
import type { NativeCommandRequest, NativeCommandResult } from '@hapi/protocol/codexThreadCommands'
import { useTranslation } from '@/lib/use-translation'
import { record } from './presentation'

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

function Usage({ result }: { result: Extract<Result, { command: 'usage' }> }) {
    const { t } = useTranslation()
    const summary = record(result.usage?.summary)
    const thread = record(result.usage?.threadUsage)
    const rates = record(result.rateLimits?.rateLimits)
    const primary = record(rates.primary)
    const secondary = record(rates.secondary)
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : null
    const fields = [
        [t('nativeManagement.lifetimeTokens'), number(summary.lifetimeTokens)],
        [t('nativeManagement.peakDailyTokens'), number(summary.peakDailyTokens)],
        [t('nativeManagement.threadCredits'), typeof thread.estimatedUsageCreditsMicros === 'number' ? (thread.estimatedUsageCreditsMicros / 1_000_000).toLocaleString() : null],
        [t('nativeManagement.primaryUsed'), typeof primary.usedPercent === 'number' ? `${primary.usedPercent}%` : null],
        [t('nativeManagement.secondaryUsed'), typeof secondary.usedPercent === 'number' ? `${secondary.usedPercent}%` : null],
    ].filter((field): field is [string, string] => field[1] !== null)
    return <>
        <p className="text-sm font-medium">{t('nativeManagement.usageTitle')}</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {fields.map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}
        </dl>
        {Object.entries(result.unavailable).map(([key, error]) => <p key={key} className="mt-2 text-sm text-[var(--app-hint)]">{error}</p>)}
        {(result.usage || result.rateLimits) && <details className="mt-2 text-xs">
            <summary className="cursor-pointer">{t('nativeManagement.usageDetails')}</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ usage: result.usage, rateLimits: result.rateLimits }, null, 2)}</pre>
        </details>}
    </>
}

export function NativeManagementResult({ result, pendingCommand, pending, disabled, execute, dismiss }: {
    result: Result | null
    pendingCommand: string | null
    pending: boolean
    disabled: boolean
    execute: (request: NativeCommandRequest) => Promise<NativeCommandResult>
    dismiss: () => void
}) {
    const { t } = useTranslation()
    const [attempted, setAttempted] = useState<Set<string>>(() => new Set())
    if (pendingCommand === 'recap') return <div role="status" className="mx-3 rounded-lg border p-3 text-sm">{t('nativeManagement.recapPending')}</div>
    if (!result) return null
    return <section aria-label={t('nativeManagement.resultLabel')} className="mx-3 max-h-[min(45vh,24rem)] overflow-y-auto overscroll-contain rounded-lg border p-3">
        <div className="float-right ml-2"><button type="button" aria-label={t('nativeManagement.close')} onClick={dismiss}>×</button></div>
        {result.command === 'compact' && <p className="text-sm" role="status">{t('nativeManagement.compactAccepted')}</p>}
        {result.command === 'recap' && <><p className="text-sm font-medium">{t('nativeManagement.recapTitle')}</p><p className="mt-1 whitespace-pre-wrap text-sm">{result.text}</p><p className="mt-2 text-xs text-[var(--app-hint)]">{t('nativeManagement.recapSeparate')}</p></>}
        {result.command === 'usage' && <Usage result={result} />}
        {result.command === 'approve' && (result.action === 'retry' ? <p className="text-sm" role="status">{t('nativeManagement.retryAccepted')}</p>
            : result.denial ? <>
                <p className="text-sm font-medium">{t('nativeManagement.deniedAction')}</p>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{actionDescription(result.denial.action)}</pre>
                {result.denial.action.type === 'request_permissions' && <pre className="mt-2 whitespace-pre-wrap break-words text-sm">{JSON.stringify(result.denial.action.permissions, null, 2)}</pre>}
                {typeof result.denial.action.cwd === 'string' && <p className="mt-1 break-all text-xs text-[var(--app-hint)]">{result.denial.action.cwd}</p>}
                {result.denial.rationale && <p className="mt-2 whitespace-pre-wrap text-sm">{result.denial.rationale}</p>}
                <p className="mt-2 text-xs text-[var(--app-hint)]">{t('nativeManagement.retryPolicy')}</p>
                <button type="button" className="mt-2 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                    disabled={disabled || pending || attempted.has(result.denial.reviewId)}
                    onClick={() => {
                        const reviewId = result.denial!.reviewId
                        setAttempted(previous => new Set(previous).add(reviewId))
                        void execute({ command: { command: 'approve', action: 'retry', reviewId } }).catch(() => {})
                    }}>{t('nativeManagement.retryOnce')}</button>
            </> : <p className="text-sm">{t('nativeManagement.noDenial')}</p>)}
    </section>
}
