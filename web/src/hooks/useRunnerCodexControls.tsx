import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session, ThreadGoal } from '@/types/api'
import type { CodexGoalControlRequest } from '@hapi/protocol/codexGoalControl'
import { useTranslation } from '@/lib/use-translation'

export function useRunnerCodexControls(api: ApiClient, session: Session, native: boolean) {
    const enabled = !native && session.metadata?.flavor === 'codex' && Boolean(session.metadata.capabilities?.concurrentClients)
    const snapshot = session.agentState?.codexGoal
    const snapshotKey = JSON.stringify(snapshot)
    const [goal, setGoal] = useState<ThreadGoal | null | undefined>(snapshot)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const busy = useRef(false)
    const revision = useRef({ key: snapshotKey, value: 0 })
    if (revision.current.key !== snapshotKey) revision.current = { key: snapshotKey, value: revision.current.value + 1 }
    // Unrelated agent-state packets may contain a new object for the same
    // goal. Only a changed native snapshot supersedes an acknowledged result.
    useEffect(() => { setGoal(snapshot) }, [snapshotKey])
    const perform = useCallback(async (work: () => Promise<void>) => {
        if (!enabled || !session.active || busy.current) return
        busy.current = true; setPending(true); setError(null)
        try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { busy.current = false; setPending(false) }
    }, [enabled, session.active])
    const controlGoal = useCallback((command: CodexGoalControlRequest) => perform(async () => {
        const before = revision.current.value
        const result = await api.controlCodexGoal(session.id, command)
        if (command.action === 'clear' && result.cleared === false) throw new Error('The goal was not cleared. Refresh and try again.')
        if (before === revision.current.value) setGoal(result.goal)
    }), [api, session.id, perform])
    const leavePlan = useCallback(() => perform(() => api.setCollaborationMode(session.id, 'default')), [api, session.id, perform])
    const goalUnavailable = session.agentState?.codexGoalUnavailable
    return { enabled, goal, pending, error: error ?? (enabled && goal ? goalUnavailable : null), goalUnavailable, controlGoal, leavePlan }
}

export function RunnerPlanButton({ controls, session }: { controls: ReturnType<typeof useRunnerCodexControls>; session: Session }) {
    const { t } = useTranslation()
    if (!controls.enabled || session.collaborationMode !== 'plan') return null
    return <button type="button" aria-pressed="true" aria-label={t('nativeCommands.planOff')} title={t('nativeCommands.plan')}
        data-testid="runner-plan-toggle" disabled={!session.active || controls.pending}
        className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[var(--app-link)]/10 px-2 text-xs text-[var(--app-link)] disabled:opacity-50"
        onClick={() => void controls.leavePlan()}>Plan <span aria-hidden="true">×</span></button>
}
