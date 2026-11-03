import { useLayoutEffect, useRef, useState } from 'react'
import type { ThreadGoal } from '@/types/api'
import type { CodexGoalControlRequest } from '@hapi/protocol/codexGoalControl'
import { MAX_CODEX_GOAL_OBJECTIVE_CHARS } from '@hapi/protocol/codexThreadCommands'
import { useTranslation } from '@/lib/use-translation'
import { commandNumber } from '@hapi/protocol/commandNumber'

type GoalAction = (command: CodexGoalControlRequest) => Promise<boolean>
const actionClass = 'rounded px-1.5 py-1 text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-50'

function GoalEditor({ goal, disabled, pending, onAction, onClose }: {
    goal: ThreadGoal | null; disabled: boolean; pending: boolean; onAction: GoalAction; onClose: () => void
}) {
    const { t } = useTranslation()
    const [original] = useState(goal?.objective ?? null)
    const [draft, setDraft] = useState(original ?? '')
    const input = useRef<HTMLTextAreaElement>(null)
    const objective = draft.trim()
    const changedElsewhere = (goal?.objective ?? null) !== original
    const tooLong = Array.from(objective).length > MAX_CODEX_GOAL_OBJECTIVE_CHARS
    const canSave = !disabled && !pending && !changedElsewhere && !tooLong && objective.length > 0 && objective !== original
    useLayoutEffect(() => {
        if (!input.current) return
        input.current.style.height = 'auto'
        input.current.style.height = `${Math.min(128, Math.max(56, input.current.scrollHeight))}px`
    }, [draft])
    const save = async () => {
        if (!canSave) return
        const accepted = await onAction(original === null ? { action: 'set', objective }
            : { action: 'edit', objective, expectedObjective: original })
        if (accepted) onClose()
    }
    return <form data-testid="codex-goal-editor" onSubmit={event => { event.preventDefault(); void save() }} className="py-1">
        <textarea ref={input} autoFocus aria-label={t('goalEditor.objective')} placeholder={t('goalEditor.placeholder')}
            className="hapi-composer-field block max-h-32 min-h-14 w-full resize-none overflow-y-auto rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:ring-1 focus:ring-[var(--app-link)]"
            value={draft} disabled={disabled || pending} onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape' && !pending) { event.preventDefault(); onClose() }
                else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} />
        {changedElsewhere ? <div role="alert" className="pt-1 text-red-600">{t('goalEditor.changedElsewhere')}</div> : null}
        {tooLong ? <div role="alert" className="pt-1 text-red-600">{t('nativeCommands.goalTooLong', { max: MAX_CODEX_GOAL_OBJECTIVE_CHARS })}</div> : null}
        {original !== null && objective !== original ? <div className="pt-1 text-[var(--app-hint)]">{t('goalEditor.usageReset')}</div> : null}
        <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={actionClass} disabled={pending} aria-label={t('goalEditor.cancelEditing')} onClick={onClose}>{t('button.cancel')}</button>
            <button type="submit" className={actionClass} disabled={!canSave}>{original === null ? t('goalEditor.start') : t('goalEditor.save')}</button>
        </div>
    </form>
}

/** Shared lifecycle controls; editing and clearing are separate actions. */
export function CodexGoalControls({ goal, editing, onEditingChange, disabled, pending, onAction }: {
    goal: ThreadGoal | null; editing: boolean; onEditingChange: (editing: boolean) => void
    disabled: boolean; pending: boolean; onAction: GoalAction
}) {
    const { t } = useTranslation()
    if (!goal && !editing) return null
    return <section className="py-1 text-xs text-[var(--app-hint)]" data-testid="codex-goal-controls">
        {editing ? <GoalEditor goal={goal} disabled={disabled} pending={pending} onAction={onAction} onClose={() => onEditingChange(false)} /> : goal ? <>
            <div className="flex flex-wrap items-center gap-2">
                <span>{t('nativeCommands.goal')}: {t(`nativeCommands.goalStatus.${goal.status}`)}</span>
                <button type="button" className={actionClass} disabled={disabled || pending} onClick={() => onEditingChange(true)}>{t('goalEditor.edit')}</button>
                {goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked' ? <button type="button" className={actionClass} disabled={disabled || pending}
                    onClick={() => void onAction({ action: goal.status === 'active' ? 'pause' : 'resume' })}>{goal.status === 'active' ? t('nativeCommands.pause') : t('nativeCommands.resume')}</button> : null}
                <button type="button" className={actionClass} disabled={disabled || pending} onClick={() => void onAction({ action: 'clear' })}>{t('goalEditor.clear')}</button>
            </div>
            <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[var(--app-fg)]" data-hapi-nested-scroll="true">{goal.objective}</div>
            <div>{t('nativeCommands.tokens', { used: commandNumber(goal.tokensUsed), budget: goal.tokenBudget == null ? t('nativeCommands.unlimited') : commandNumber(goal.tokenBudget) })} · {t('nativeCommands.timeUsed', { seconds: commandNumber(goal.timeUsedSeconds) })}</div>
        </> : null}
    </section>
}
