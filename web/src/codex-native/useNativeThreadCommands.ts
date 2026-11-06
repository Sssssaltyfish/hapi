import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { NativeEvent, NativeRecord } from './types'
import { record } from './presentation'
import type { NativeCommandRequest, NativeCommandResult, NativeCommandState, NativeGoal } from './nativeThreadCommands'
import { isNativeCommandSubmissionUnconfirmed, nativeCommandErrorMessage } from './nativeThreadCommands'
import { useTranslation } from '@/lib/use-translation'

type ManagementResult = Exclude<NativeCommandResult, { command: 'plan' | 'goal' }>
type RecapResult = Extract<NativeCommandResult, { command: 'recap' }>
type RecapRequest = { kind: 'recap'; id: number; clientId: string; hidden: boolean; pending: boolean; canceling: boolean; canceled: boolean; result?: RecapResult }
type Presentation = RecapRequest | { kind: 'result'; id: number; result: ManagementResult }
export type NativeRecapView = Pick<RecapRequest, 'clientId' | 'hidden' | 'pending' | 'canceling'> & { ready: boolean }
export class NativeRecapCanceledError extends Error {}
export class NativeCommandInactiveError extends Error {}

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
    const [feedbacks, setFeedbacks] = useState<{ text: string; error: boolean }[]>([])
    const setFeedback = (value: { text: string; error: boolean } | null) => {
        if (value) setFeedbacks(previous => [...previous, value].slice(-20))
    }
    const [pending, setPending] = useState(false)
    const [goalEditorOpen, setGoalEditorOpen] = useState(false)
    const resultSequence = useRef(0)
    const [presentation, setPresentation] = useState<{ scope: string; items: Presentation[] }>({ scope: '', items: [] })
    const commandScope = `${scope ?? ''}:${endpointId}:${threadId}`
    const submissions = useRef({ scope: commandScope, active: true, latest: 0, count: 0, presentations: [] as Presentation[] })
    if (submissions.current.scope !== commandScope) {
        submissions.current = { scope: commandScope, active: true, latest: 0, count: 0, presentations: [] }
    }
    useEffect(() => {
        const batch = submissions.current
        batch.active = true
        setPending(false); setFeedbacks([])
        setPresentation({ scope: commandScope, items: [] })
        return () => { batch.active = false }
    }, [commandScope])
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
    const publishPresentation = useCallback((batch: typeof submissions.current) => {
        if (submissions.current !== batch || !batch.active) return
        // Live runs keep their controls. Completed output, including hidden
        // recaps, shares the existing bounded result capacity.
        const completed = batch.presentations.filter(entry => entry.kind === 'result' || (!entry.pending && !entry.canceling))
        const retained = new Set(completed.slice(-20).map(entry => entry.id))
        batch.presentations = batch.presentations.filter(entry => entry.kind === 'recap' && (entry.pending || entry.canceling) || retained.has(entry.id))
        setPresentation({ scope: batch.scope, items: batch.presentations.map(entry => ({ ...entry })) })
    }, [])
    const hideRecap = useCallback((clientId: string) => {
        const batch = submissions.current
        const recap = batch.presentations.find((entry): entry is RecapRequest => entry.kind === 'recap' && entry.clientId === clientId)
        if (!batch.active || !recap || recap.canceled) return
        recap.hidden = true
        publishPresentation(batch)
    }, [publishPresentation])
    const showRecap = useCallback((clientId: string) => {
        const batch = submissions.current
        const recap = batch.presentations.find((entry): entry is RecapRequest => entry.kind === 'recap' && entry.clientId === clientId)
        if (!batch.active || !recap || recap.canceled) return
        recap.hidden = false
        if (recap.result) batch.presentations = [recap, ...batch.presentations.filter(entry => entry !== recap)]
        publishPresentation(batch)
    }, [publishPresentation])
    const cancelRecap = useCallback(async (clientId: string) => {
        const batch = submissions.current
        const recap = batch.presentations.find((entry): entry is RecapRequest => entry.kind === 'recap' && entry.clientId === clientId)
        if (!batch.active || !recap || recap.canceled || recap.canceling || !recap.pending) return
        recap.canceling = true; publishPresentation(batch)
        try {
            const response = await api.cancelCodexNativeRecap(threadId, clientId)
            if (submissions.current !== batch || !batch.active) return
            recap.canceling = false
            if (response.canceled) {
                recap.canceled = true
                batch.presentations = batch.presentations.filter(entry => entry !== recap)
            }
        } catch (error) {
            if (submissions.current !== batch || !batch.active) return
            recap.canceling = false
            if (!recap.canceled) {
                setFeedback({ text: nativeCommandErrorMessage(error), error: true })
            }
        } finally { publishPresentation(batch) }
    }, [api, threadId, publishPresentation])
    const execute = useCallback(async (input: NativeCommandRequest): Promise<NativeCommandResult> => {
        const batch = submissions.current
        if (!batch.active) throw new NativeCommandInactiveError('Conversation changed.')
        const submission = ++batch.latest
        const request = input.command.command === 'recap' ? { ...input, clientId: input.clientId ?? crypto.randomUUID() } : input
        const recap: RecapRequest | undefined = request.command.command === 'recap' ? { kind: 'recap', id: ++resultSequence.current, clientId: request.clientId!, hidden: false, pending: true, canceling: false, canceled: false } : undefined
        if (recap) { batch.presentations.push(recap); publishPresentation(batch) }
        batch.count++
        const isLatest = () => submissions.current === batch && batch.active && submission === batch.latest
        setPending(true); setFeedback(null)
        const revision = eventRevision.current
        try {
            const result = await api.codexNativeCommand(threadId, request)
            if (submissions.current !== batch || !batch.active) throw new NativeCommandInactiveError('Conversation changed.')
            if (result.command === 'recap' && recap) {
                recap.pending = false; recap.result = result
                if (recap.canceled) throw new NativeRecapCanceledError('Recap was canceled.')
                batch.presentations = [...batch.presentations.filter(entry => entry !== recap), recap]
                publishPresentation(batch)
                return result
            }
            if (result.command !== 'plan' && result.command !== 'goal') {
                batch.presentations.push({ kind: 'result', id: ++resultSequence.current, result })
                publishPresentation(batch)
                return result
            }
            // Acknowledged mutation remains successful even if the following
            // read fails. Apply only fields returned by the daemon itself.
            const canApply = isLatest() && revision === eventRevision.current
            // Also invalidate a read that started before this acknowledgement
            // when no SSE arrived. Initial pending queries may reuse that read.
            if (canApply) eventRevision.current++
            client.setQueryData<NativeCommandState>(key, previous => {
                if (!previous || !canApply) return previous
                if (result.command === 'plan' && result.applied.collaborationMode) return { ...previous, collaborationMode: result.applied.collaborationMode as NativeCommandState['collaborationMode'] }
                if (result.command === 'goal' && result.goal !== undefined) return { ...previous, goal: result.goal }
                return previous
            })
            if (result.command === 'goal' && result.action === 'show') setGoalEditorOpen(true)
            setFeedback(result.command === 'plan' && result.submission?.startError
                ? { text: t('nativeCommands.queuedStartError', { error: result.submission.startError }), error: true }
                : result.command === 'goal' && result.action === 'clear' && result.cleared === false
                    ? { text: t('nativeCommands.notCleared'), error: true }
                    : null)
            void query.refetch()
            return result
        } catch (error) {
            if (submissions.current !== batch || !batch.active) throw new NativeCommandInactiveError('Conversation changed.')
            if (recap) {
                recap.pending = false
                batch.presentations = batch.presentations.filter(entry => entry !== recap)
                if (recap.canceled || nativeCommandErrorMessage(error) === 'Recap was canceled.') {
                    recap.canceled = true; publishPresentation(batch)
                    throw new NativeRecapCanceledError('Recap was canceled.')
                }
                // Failed runs have no result to reopen; other command feedback remains independent.
                recap.canceled = true; publishPresentation(batch)
            }
            if (submissions.current === batch) setFeedback({ text: isNativeCommandSubmissionUnconfirmed(error) ? t('nativeCommands.unconfirmed') : nativeCommandErrorMessage(error), error: true })
            throw error
        } finally {
            batch.count--
            if (submissions.current === batch && batch.active) {
                setPending(batch.count > 0)
            }
        }
    }, [api, threadId, endpointId, client, query.refetch, t, scope, publishPresentation])
    const entries = presentation.scope === commandScope ? presentation.items : []
    const managementEntry = entries.find(entry => entry.kind === 'result' || (!entry.pending && !entry.canceling && !entry.hidden && entry.result))
    return { state: query.data, loading: query.isPending, readError: query.error, pending, feedback: feedbacks[0] ?? null,
        goalEditorOpen, setGoalEditorOpen,
        managementResult: managementEntry?.result ?? null,
        recaps: entries.filter((entry): entry is RecapRequest => entry.kind === 'recap').map(({ clientId, hidden, pending, canceling, result }) => ({ clientId, hidden, pending, canceling, ready: Boolean(result) } satisfies NativeRecapView)), hideRecap, showRecap, cancelRecap,
        dismissManagementResult: () => {
            const batch = submissions.current
            if (!managementEntry || batch.scope !== commandScope || !batch.active) return
            batch.presentations = batch.presentations.filter(entry => entry.id !== managementEntry.id)
            publishPresentation(batch)
        },
        dismissFeedback: () => setFeedbacks(previous => previous.slice(1)), reportError: (text: string) => setFeedback({ text, error: true }), refresh: query.refetch, execute }
}
export type ReturnTypeOfNativeCommands = ReturnType<typeof useNativeThreadCommands>
