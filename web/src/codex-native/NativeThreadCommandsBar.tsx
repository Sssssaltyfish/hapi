import type { ReturnTypeOfNativeCommands } from './useNativeThreadCommands'
import { useTranslation } from '@/lib/use-translation'

export function NativePlanButton({ commands, disabled }: { commands: ReturnTypeOfNativeCommands; disabled: boolean }) {
    const { t } = useTranslation()
    if (!commands.state?.capabilities.plan || commands.state.collaborationMode?.mode !== 'plan') return null
    return <button type="button" data-testid="native-plan-toggle" aria-pressed="true"
        aria-label={t('nativeCommands.planOff')} title={t('nativeCommands.plan')}
        className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[var(--app-link)]/10 px-2 text-xs text-[var(--app-link)] transition-colors hover:bg-[var(--app-link)]/20 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || commands.pending}
        onClick={() => void commands.execute({ command: { command: 'plan', mode: 'default' } }).catch(() => {})}>
        Plan <span aria-hidden="true">×</span>
    </button>
}

export function NativeThreadCommandsBar({ commands, disabled }: { commands: ReturnTypeOfNativeCommands; disabled: boolean }) {
    const { t } = useTranslation()
    const state = commands.state
    const goal = state?.goal
    const expanded = Boolean(goal || commands.feedback || commands.readError)
    if (!expanded) return null
    const actionClass = 'rounded px-1.5 py-1 text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-50'
    return <div className="mx-auto w-full max-w-content px-3 py-1 text-xs text-[var(--app-hint)]" data-testid="native-thread-commands">
        {goal ? <div className="py-1">
            <div className="flex flex-wrap items-center gap-2"><span>{t('nativeCommands.goal')}: {t(`nativeCommands.goalStatus.${goal.status}`)}</span>
                {state?.capabilities.goal ? <>
                    {goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked' ? <button type="button" className={actionClass} disabled={disabled || commands.pending}
                        onClick={() => void commands.execute({ command: { command: 'goal', action: goal.status === 'active' ? 'pause' : 'resume' } }).catch(() => {})}>{goal.status === 'active' ? t('nativeCommands.pause') : t('nativeCommands.resume')}</button> : null}
                    <button type="button" className={actionClass} disabled={disabled || commands.pending}
                        onClick={() => void commands.execute({ command: { command: 'goal', action: 'clear' } }).catch(() => {})}>{t('nativeCommands.clear')}</button>
                </> : null}
            </div>
            <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[var(--app-fg)]" data-hapi-nested-scroll="true">{goal.objective}</div>
            <div>{t('nativeCommands.tokens', { used: goal.tokensUsed.toLocaleString(), budget: goal.tokenBudget === null ? t('nativeCommands.unlimited') : goal.tokenBudget.toLocaleString() })} · {t('nativeCommands.timeUsed', { seconds: goal.timeUsedSeconds })}</div>
        </div> : null}
        {commands.feedback ? <div className="flex items-start gap-2" role={commands.feedback.error ? 'alert' : 'status'}>
            <span className={`min-w-0 flex-1 break-words ${commands.feedback.error ? 'text-red-600' : ''}`}>{commands.feedback.text}</span>
            <button type="button" className={actionClass} aria-label={t('button.dismiss')} onClick={commands.dismissFeedback}>×</button>
        </div> : null}
        {commands.readError ? <div role="status">{t('nativeCommands.refreshFailed')} <button type="button" className={actionClass} onClick={() => void commands.refresh()}>{t('button.retry')}</button></div> : null}
    </div>
}
