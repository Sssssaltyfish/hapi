import { useLayoutEffect, useRef, useState } from 'react'
import type { ThreadGoal } from '@/types/api'
import type { CodexGoalControlRequest } from '@hapi/protocol/codexGoalControl'
import { MAX_CODEX_GOAL_OBJECTIVE_CHARS } from '@hapi/protocol/codexThreadCommands'
import { useTranslation } from '@/lib/use-translation'

type GoalAction = (command: CodexGoalControlRequest) => Promise<boolean>
type GoalIconName = 'edit' | 'pause' | 'resume' | 'clear' | 'cancel' | 'save'
const actionClass = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:bg-[var(--app-link)]/15 focus-visible:text-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11'

function GoalIcon({ name }: { name: GoalIconName }) {
    return <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        {name === 'edit' ? <><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15l-1 6Z" /></>
            : name === 'pause' ? <><path d="M8 5v14M16 5v14" /></>
                : name === 'resume' ? <path d="m8 4 12 8-12 8Z" />
                    : name === 'clear' ? <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>
                        : name === 'cancel' ? <path d="m6 6 12 12M6 18 18 6" />
                            : <path d="m5 12 4 4L19 6" />}
    </svg>
}

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
        input.current.style.height = `${Math.min(96, input.current.scrollHeight)}px`
    }, [draft])
    const save = async () => {
        if (!canSave) return
        const accepted = await onAction(original === null ? { action: 'set', objective }
            : { action: 'edit', objective, expectedObjective: original })
        if (accepted) onClose()
    }
    return <form data-testid="codex-goal-editor" onSubmit={event => { event.preventDefault(); void save() }}>
        <div className="flex items-center gap-1">
            <textarea ref={input} autoFocus rows={1} aria-label={t('goalEditor.objective')} placeholder={t('goalEditor.placeholder')}
                className="hapi-composer-field block min-h-9 max-h-24 min-w-0 flex-1 resize-none overflow-y-auto rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                value={draft} disabled={disabled || pending} onChange={event => setDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Escape' && !pending) { event.preventDefault(); onClose() }
                    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} />
            <div role="group" aria-label={t('nativeCommands.goal')} className="flex shrink-0 items-center">
                <button type="button" className={actionClass} disabled={pending} aria-label={t('goalEditor.cancelEditing')} title={t('goalEditor.cancelEditing')} onClick={onClose}><GoalIcon name="cancel" /></button>
                <button type="submit" className={actionClass} disabled={!canSave} aria-label={original === null ? t('goalEditor.start') : t('goalEditor.save')} title={original === null ? t('goalEditor.start') : t('goalEditor.save')}><GoalIcon name="save" /></button>
            </div>
        </div>
        {changedElsewhere ? <div role="alert" className="pt-1 text-red-600">{t('goalEditor.changedElsewhere')}</div> : null}
        {tooLong ? <div role="alert" className="pt-1 text-red-600">{t('nativeCommands.goalTooLong', { max: MAX_CODEX_GOAL_OBJECTIVE_CHARS })}</div> : null}
        {original !== null && objective !== original ? <div className="pt-1 text-[var(--app-hint)]">{t('goalEditor.usageReset')}</div> : null}
    </form>
}

/** Shared lifecycle controls; editing and clearing are separate actions. */
export function CodexGoalControls({ goal, editing, onEditingChange, disabled, pending, onAction }: {
    goal: ThreadGoal | null; editing: boolean; onEditingChange: (editing: boolean) => void
    disabled: boolean; pending: boolean; onAction: GoalAction
}) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    if (!goal && !editing) return null
    return <section className="text-xs text-[var(--app-hint)]" data-testid="codex-goal-controls">
        {editing ? <GoalEditor goal={goal} disabled={disabled} pending={pending} onAction={onAction} onClose={() => onEditingChange(false)} /> : goal ? <>
            <div className="flex items-center gap-1">
                <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-start">
                    <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3 w-3 shrink-0 ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor"><path d="m6 3 5 5-5 5" /></svg>
                    <span className="shrink-0">{t('nativeCommands.goal')}: {t(`nativeCommands.goalStatus.${goal.status}`)}</span>
                    {!expanded && <span className="truncate text-[var(--app-fg)]">{goal.objective}</span>}
                </button>
                <div role="group" aria-label={t('nativeCommands.goal')} className="flex shrink-0 items-center">
                    <button type="button" className={actionClass} disabled={disabled || pending} aria-label={t('goalEditor.edit')} title={t('goalEditor.edit')} onClick={() => onEditingChange(true)}><GoalIcon name="edit" /></button>
                    {goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked' ? <button type="button" className={actionClass} disabled={disabled || pending}
                        aria-label={goal.status === 'active' ? t('nativeCommands.pause') : t('nativeCommands.resume')} title={goal.status === 'active' ? t('nativeCommands.pause') : t('nativeCommands.resume')}
                        onClick={() => void onAction({ action: goal.status === 'active' ? 'pause' : 'resume' })}><GoalIcon name={goal.status === 'active' ? 'pause' : 'resume'} /></button> : null}
                    <button type="button" className={actionClass} disabled={disabled || pending} aria-label={t('goalEditor.clear')} title={t('goalEditor.clear')} onClick={() => void onAction({ action: 'clear' })}><GoalIcon name="clear" /></button>
                </div>
            </div>
            {expanded && <div className="pb-1">
                <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[var(--app-fg)]" data-hapi-nested-scroll="true">{goal.objective}</div>
                <div>{t('nativeCommands.tokens', { used: goal.tokensUsed.toLocaleString(), budget: goal.tokenBudget == null ? t('nativeCommands.unlimited') : goal.tokenBudget.toLocaleString() })} · {t('nativeCommands.timeUsed', { seconds: goal.timeUsedSeconds })}</div>
            </div>}
        </> : null}
    </section>
}
