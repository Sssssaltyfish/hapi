import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { NativeEvent, NativeRecord } from './types'
import { record } from './presentation'
import type { NativeCommandRequest, NativeCommandResult, NativeCommandState, NativeGoal } from './nativeThreadCommands'
import { isNativeCommandSubmissionUnconfirmed, nativeCommandErrorMessage } from './nativeThreadCommands'
import { useTranslation } from '@/lib/use-translation'

export function useNativeThreadCommands(api: ApiClient, threadId: string, endpointId: string, enabled: boolean,
    subscribe: (listener: (event: NativeEvent) => void) => () => void) {
    const { t } = useTranslation()
    const client = useQueryClient()
    const scope = api.getConversationCacheScope?.().key
    const key = ['codex-native', scope, endpointId, 'commands', threadId] as const
    const eventRevision = useRef(0)
    const eventState = useRef<{ goal?: { revision: number; value: NativeGoal | null }; mode?: { revision: number; value: NativeRecord | null } }>({})
    const query = useQuery({ queryKey: key, queryFn: async ({ signal }) => {
        // A settings/goal notification can arrive while the HTTP read is in
        // flight. One extra read is enough; newer event fields take priority
        // even while goal counters keep streaming continuously.
        let revision = eventRevision.current
        let state = await api.getCodexNativeCommands(threadId, signal)
        signal.throwIfAborted()
        if (revision !== eventRevision.current) {
            revision = eventRevision.current
            state = await api.getCodexNativeCommands(threadId, signal)
            signal.throwIfAborted()
        }
        const latest = eventState.current
        return { ...state,
            ...(latest.goal && latest.goal.revision > revision ? { goal: latest.goal.value } : {}),
            ...(latest.mode && latest.mode.revision > revision ? { collaborationMode: latest.mode.value } : {}),
        }
    },
        enabled, staleTime: 0, retry: false, refetchOnWindowFocus: true })
    const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
    const [pending, setPending] = useState(false)
    const [pendingCommand, setPendingCommand] = useState<string | null>(null)
    const [managementResult, setManagementResult] = useState<Exclude<NativeCommandResult, { command: 'plan' | 'goal' }> | null>(null)
    const inFlight = useRef(false)
    useEffect(() => subscribe(event => {
        if (['hapi/ready', 'thread/settings/updated', 'thread/goal/updated', 'thread/goal/cleared'].includes(event.method)) {
            eventRevision.current++
            if (event.method === 'thread/goal/updated' && event.params.goal) {
                eventState.current.goal = { revision: eventRevision.current, value: event.params.goal as NativeGoal }
                client.setQueryData<NativeCommandState>(key, previous => previous ? { ...previous, goal: event.params.goal as NativeGoal } : previous)
                return
            }
            if (event.method === 'thread/goal/cleared') {
                eventState.current.goal = { revision: eventRevision.current, value: null }
                client.setQueryData<NativeCommandState>(key, previous => previous ? { ...previous, goal: null } : previous)
                return
            }
            const settings = record(event.params.threadSettings ?? event.params.settings)
            if (settings.collaborationMode !== undefined) eventState.current.mode = {
                revision: eventRevision.current, value: settings.collaborationMode === null ? null : record(settings.collaborationMode),
            }
            if (event.method === 'thread/settings/updated') {
                const mode = eventState.current.mode
                if (mode?.revision === eventRevision.current) client.setQueryData<NativeCommandState>(key, previous => previous ? { ...previous, collaborationMode: mode.value } : previous)
                return
            }
            void client.invalidateQueries({ queryKey: key })
        }
    }), [subscribe, client, api, threadId, endpointId, scope])
    const execute = useCallback(async (request: NativeCommandRequest): Promise<NativeCommandResult> => {
        if (inFlight.current) throw new Error(t('nativeCommands.busy'))
        inFlight.current = true; setPending(true); setFeedback(null)
        setPendingCommand(request.command.command)
        const revision = eventRevision.current
        try {
            const result = await api.codexNativeCommand(threadId, request)
            if (result.command !== 'plan' && result.command !== 'goal') {
                setManagementResult(result)
                return result
            }
            // Acknowledged mutation remains successful even if the following
            // read fails. Apply only fields returned by the daemon itself.
            const canApply = revision === eventRevision.current
            // Also invalidate a read that started before this acknowledgement
            // when no SSE arrived. Initial pending queries may reuse that read.
            if (canApply) eventRevision.current++
            client.setQueryData<NativeCommandState>(key, previous => {
                if (!previous || !canApply) return previous
                if (result.command === 'plan' && result.applied.collaborationMode) return { ...previous, collaborationMode: result.applied.collaborationMode as NativeCommandState['collaborationMode'] }
                if (result.command === 'goal' && result.goal !== undefined) return { ...previous, goal: result.goal }
                return previous
            })
            setFeedback(result.command === 'plan' && result.submission?.startError
                ? { text: t('nativeCommands.queuedStartError', { error: result.submission.startError }), error: true }
                : result.command === 'goal' && result.action === 'clear' && result.cleared === false
                    ? { text: t('nativeCommands.notCleared'), error: true }
                    : result.command === 'goal' && result.action === 'show' && result.goal === null
                        ? { text: t('nativeCommands.noGoal'), error: false }
                        : null)
            void query.refetch()
            return result
        } catch (error) {
            setFeedback({ text: isNativeCommandSubmissionUnconfirmed(error) ? t('nativeCommands.unconfirmed') : nativeCommandErrorMessage(error), error: true })
            throw error
        } finally { inFlight.current = false; setPending(false); setPendingCommand(null) }
    }, [api, threadId, endpointId, client, query.refetch, t, scope])
    return { state: query.data, loading: query.isPending, readError: query.error, pending, feedback,
        managementResult, pendingCommand, dismissManagementResult: () => setManagementResult(null),
        dismissFeedback: () => setFeedback(null), reportError: (text: string) => setFeedback({ text, error: true }), refresh: query.refetch, execute }
}
export type ReturnTypeOfNativeCommands = ReturnType<typeof useNativeThreadCommands>
