import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SessionChat } from '@/components/SessionChat'
import { ApiError, type ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import type { ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { nativeAsyncReplyTurn, nativeQuestionReplies, nativeState, record } from './presentation'
import { createNativeItemProjector, projectNativeItems } from './projectNativeItems'
import { nativeReasoningMessageId, nativeReasoningParts } from './nativeReasoning'
import { useNativeThread } from './useNativeThread'
import { createNativeSessionApiAdapter } from './nativeSessionApiAdapter'
import { useNativeSuggestions } from './useNativeSuggestions'
import { getConversationReadingPosition } from '@/lib/conversation-reading-position'
import { getTimelineBlockSourceIds } from '@/lib/assistant-runtime'
import { getNativeApprovalStatusLabel, NativeApprovalSettings } from './NativeApprovalSettings'
import { useNativeQueue } from './useNativeQueue'
import { NativeQueuedMessagesBar } from './NativeQueuedMessagesBar'
import type { NativeItemEntry } from './types'
import type { TimelineHistoryLocator } from '@/lib/stable-chat-timeline'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from '@/hooks/queries/useSessions'
import { nativeThreadReferenceMessage } from './nativeThreadReferences'
import { NativeCommandInactiveError, NativeRecapCanceledError, useNativeThreadCommands } from './useNativeThreadCommands'
import { NativePlanButton, NativeThreadCommandsBar } from './NativeThreadCommandsBar'
import { isNativeCommandSubmissionUnconfirmed } from './nativeThreadCommands'
import { parseCodexThreadCommand, MAX_CODEX_GOAL_OBJECTIVE_CHARS } from '@hapi/protocol/codexThreadCommands'
import { serializeResponseAnnotations, splitResponseAnnotations } from '@/lib/responseAnnotations'
import { useTranslation } from '@/lib/use-translation'
import { NativeManagementResult } from './NativeManagementResult'

function containsOutlineTarget(entries: NativeItemEntry[], targetMessageId: string): boolean {
    const messages = projectNativeItems(entries, [], false).messages
    const normalized = messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
    return reduceChatBlocks(normalized, null).blocks.some(block => getTimelineBlockSourceIds(block).includes(targetMessageId))
}

export function NativeSessionPage({
    api,
    session,
    onBack,
    outline,
}: {
    api: ApiClient
    session: Session
    onBack: () => void
    outline?: boolean
}) {
    const native = session.metadata!.nativeCodex!
    const endpointApi = useMemo(
        () => api.withCodexNativeEndpoint(native.endpointId),
        [api, native.endpointId]
    )
    return (
        <NativeSessionChat
            key={`${native.endpointId}:${native.threadId}:${session.id}`}
            api={endpointApi}
            session={session}
            onBack={onBack}
            outline={outline}
        />
    )
}

function NativeSessionChat({
    api,
    session,
    onBack,
    outline,
}: {
    api: ApiClient
    session: Session
    onBack: () => void
    outline?: boolean
}) {
    const native = session.metadata!.nativeCodex!
    const thread = useNativeThread(api, native.threadId, native.available !== false, session.id, getConversationReadingPosition(session.id)?.atBottom === false)
    const queryClient = useQueryClient()
    const { subscribeEvents } = thread
    useEffect(() => subscribeEvents(event => {
        if (event.method === 'thread/name/updated' && event.params.threadId === native.threadId)
            void queryClient.invalidateQueries({ queryKey: queryKeys.session(session.id), exact: true })
    }), [native.threadId, queryClient, session.id, subscribeEvents])
    const { t } = useTranslation()
    const commands = useNativeThreadCommands(api, native.threadId, native.endpointId, native.available !== false, thread.subscribeEvents)
    const commandMenu = useMemo(() => [
        ...(commands.state?.capabilities.plan ? [{ name: 'plan', description: t('nativeCommands.planDescription') }] : []),
        ...(commands.state?.capabilities.goal ? [{ name: 'goal', description: t('nativeCommands.goalDescription') }] : []),
        { name: 'compact', description: t('nativeManagement.compactDescription') },
        { name: 'approve', description: t('nativeManagement.approveDescription') },
        { name: 'recap', description: t('nativeManagement.recapDescription') },
        { name: 'usage', description: t('nativeManagement.usageDescription') },
    ], [commands.state?.capabilities.plan, commands.state?.capabilities.goal, t])
    const unconfirmedPlan = useRef<string | null>(null)
    const queue = useNativeQueue(api, native.threadId, native.available !== false, thread.subscribeEvents)
    const { sessions: mentionSessions } = useSessions(api)
    const nativeEndpoints = useQuery({ queryKey: ['codex-native', 'endpoints'], queryFn: () => api.getCodexNativeEndpoints(), staleTime: 30_000, retry: false })
    const autocompleteSuggestions = useNativeSuggestions(api, native.threadId, {
        endpointId: native.endpointId, sessions: mentionSessions, endpoints: nativeEndpoints.data?.endpoints ?? [],
        commands: commandMenu,
    })
    const observedReplies = useRef(new Map<string, string>())
    for (const [id, answer] of nativeQuestionReplies(thread.items))
        observedReplies.current.set(id, answer)
    while (observedReplies.current.size > 300)
        observedReplies.current.delete(observedReplies.current.keys().next().value!)
    const turnStateKnown = thread.detail.activeTurn !== undefined
    const activeTurn = record(thread.detail.activeTurn)
    const activeTurnId = activeTurn.status === 'inProgress' && typeof activeTurn.id === 'string' ? activeTurn.id : undefined
    const [viewMode, setViewMode] = useState<'tail' | 'history'>(() => getConversationReadingPosition(session.id)?.atBottom === false ? 'history' : 'tail')
    const reasoningTurnId = thread.includesLiveTail ? activeTurnId : undefined
    const projectLiveItems = useMemo(createNativeItemProjector, [])
    const projected = useMemo(
        () =>
            projectLiveItems(
                thread.items,
                thread.requests,
                turnStateKnown,
                observedReplies.current,
                reasoningTurnId
            ),
        [projectLiveItems, thread.items, thread.requests, turnStateKnown, reasoningTurnId]
    )
    const [sending, setSending] = useState(false)
    const historyLocators = useMemo(() => {
        const locators = new Map<string, TimelineHistoryLocator>()
        for (const entry of thread.items) {
            if (!entry.turnId) continue
            const locator: TimelineHistoryLocator = { kind: 'native', turnId: entry.turnId, itemId: entry.item.id }
            for (const suffix of ['', ':call', ':result']) locators.set(`native:${entry.item.id}${suffix}`, locator)
            if (entry.item.type === 'reasoning') nativeReasoningParts(entry.item.summary).forEach((text, index) => {
                if (text.trim()) locators.set(nativeReasoningMessageId(entry.item.id, index), locator)
            })
        }
        return locators
    }, [thread.items])
    const [settlement, setSettlement] = useState<SendMessageSettlement | null>(null)
    const [sendError, setSendError] = useState<ComposerSendError | null>(null)
    const [settingsError, setSettingsError] = useState<string | null>(null)
    const revision = useRef({ items: thread.items, reasoningTurnId, value: 0 })
    if (revision.current.items !== thread.items || revision.current.reasoningTurnId !== reasoningTurnId)
        revision.current = { items: thread.items, reasoningTurnId, value: revision.current.value + 1 }
    const detail = record(thread.detail.thread)
    const settings = record(thread.detail.threadSettings ?? { ...detail, ...thread.detail })
    const effort = Object.hasOwn(settings, 'effort') ? settings.effort : settings.reasoningEffort
    const unavailable = native.available === false
    const liveSession = useMemo<Session>(
        () => ({
            ...session,
            active: !unavailable,
            thinking:
                activeTurn.status === 'inProgress' ||
                ['active', 'running'].includes(nativeState(detail.status)),
            model: typeof settings.model === 'string' ? settings.model : session.model,
            modelReasoningEffort:
                typeof effort === 'string' || effort === null
                    ? effort
                    : session.modelReasoningEffort,
            metadata: {
                ...session.metadata!,
                ...(typeof detail.name === 'string' ? { name: detail.name } : {}),
                capabilities: { ...session.metadata?.capabilities, concurrentClients: true, permissionModes: [] },
            },
            agentState: {
                controlledByUser: false,
                steeringActive: activeTurn.status === 'inProgress',
                requests: projected.requests,
            },
        }),
        [
            session,
            unavailable,
            activeTurn.status,
            detail.status,
            detail.name,
            settings.model,
            settings.effort,
            settings.reasoningEffort,
            projected.requests,
        ]
    )
    const refresh = useCallback(async () => {
        await Promise.all([thread.refreshDetail(), thread.latest(viewMode === 'tail')])
    }, [thread.refreshDetail, thread.latest, viewMode])
    const adapterState = { model: liveSession.model, thread, projectedRequests: projected.requests }
    const committedAdapterState = useRef(adapterState)
    // Interactive operations read the requests from the latest committed view.
    useLayoutEffect(() => { committedAdapterState.current = adapterState })
    const adapter = useMemo(
        () => createNativeSessionApiAdapter(api, {
            sessionId: session.id,
            threadId: native.threadId,
            getState: () => committedAdapterState.current,
            setSettingsError,
        }),
        [api, native.threadId, session.id]
    )
    return (
        <SessionChat
            api={adapter}
            autocompleteSuggestions={autocompleteSuggestions}
            session={liveSession}
            contextUsage={thread.contextUsage}
            nativeCapabilities={{
                available: !unavailable,
                connected: thread.connected,
                approvalStatusLabel: getNativeApprovalStatusLabel(settings),
                modeControls: <NativePlanButton commands={commands} disabled={unavailable || !thread.connected} />,
                queueContent: <><NativeManagementResult result={commands.managementResult}
                    pending={commands.pending} disabled={unavailable || !thread.connected} execute={commands.execute} dismiss={commands.dismissManagementResult}
                    recaps={commands.recaps} hideRecap={commands.hideRecap} showRecap={commands.showRecap} cancelRecap={commands.cancelRecap} />
                    <NativeThreadCommandsBar commands={commands} disabled={unavailable || !thread.connected} /><NativeQueuedMessagesBar key={native.threadId} api={api} threadId={native.threadId} queue={queue} connected={thread.connected}
                    activeTurnId={activeTurnId ?? null} /></>,
                onSubmitCommand: text => {
                    const command = parseCodexThreadCommand(text)
                    if (!command) {
                        if (/^\s*\/(compact|recap|usage|approve)(?:\s|$)/i.test(text)) {
                            commands.reportError(t('nativeManagement.invalidArguments'))
                            return 'failed'
                        }
                        return 'unhandled'
                    }
                    if (command.command === 'plan' && command.prompt) {
                        if (unconfirmedPlan.current && splitResponseAnnotations(unconfirmedPlan.current).body === text) {
                            commands.reportError(t('nativeCommands.unconfirmed'))
                            setSendError({ id: Date.now(), text: unconfirmedPlan.current, message: t('nativeCommands.unconfirmed'),
                                scheduledAt: null, mutationStarted: false, restoreSuppressed: true,
                                action: { label: t('nativeCommands.allowRetry'), onClick: () => { unconfirmedPlan.current = null; setSendError(null) } } })
                            return 'failed'
                        }
                        return 'unhandled'
                    }
                    if (unavailable || !thread.connected) { commands.reportError(t('nativeCommands.disconnected')); return 'failed' }
                    if (command.command === 'goal' && command.action === 'set' && Array.from(command.objective).length > MAX_CODEX_GOAL_OBJECTIVE_CHARS) {
                        commands.reportError(t('nativeCommands.goalTooLong', { max: MAX_CODEX_GOAL_OBJECTIVE_CHARS })); return 'failed'
                    }
                    return commands.execute({ command }).then(() => 'handled' as const, error => error instanceof NativeRecapCanceledError || error instanceof NativeCommandInactiveError ? 'handled' as const : 'failed' as const)
                },
                approvalSettings: <NativeApprovalSettings
                    settings={settings}
                    disabled={unavailable || !thread.connected}
                    onChange={adapter.setNativeApprovalSettings}
                />,
            }}
            messages={projected.messages}
            historyLocators={historyLocators}
            nativeHistoryDirection={thread.historyDirection}
            onHydrateHistoryRow={async (locator, isCurrent = () => true) => {
                if (locator.kind !== 'native') return false
                const found = await thread.seekTurn(locator.turnId, locator.itemId,
                    entries => isCurrent() && entries.some(entry => entry.item.id === locator.itemId))
                if (found) setViewMode('history')
                return found
            }}
            messagesWarning={settingsError || (native.error ?? thread.error) || null}
            hasMoreMessages={Boolean(thread.cursor)}
            hasNewerMessages={thread.hasNewer}
            isSyncingTail={thread.loading}
            isLoadingMoreMessages={thread.olderLoading}
            isSending={sending}
            sendSettlement={settlement}
            viewMode={viewMode}
            messagesVersion={revision.current.value}
            historyVersion={revision.current.value}
            tailRevision={revision.current.value}
            onBack={onBack}
            onRefresh={refresh}
            onCancelLoadMore={thread.cancelOlder}
            canContinueHistoryEdge={thread.canContinueHistoryEdge}
            onPrefetchHistory={thread.prefetch}
            conversationHistoryRevision={thread.historyResetRevision}
            onLoadNewer={async (beforeApply) => {
                let appliedVersion = revision.current.value
                let addedRenderableCount = 0
                const blocks = (messages: typeof projected.messages) => reduceChatBlocks(
                    messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null),
                    { requests: projected.requests }
                ).blocks
                const previousIds = new Set(blocks(projected.messages).map(block => block.id))
                const applied = await thread.newer(entries => {
                    appliedVersion = revision.current.value + 1
                    if (beforeApply && !beforeApply(appliedVersion)) return false
                    addedRenderableCount = blocks(projectNativeItems(entries, thread.requests, turnStateKnown, observedReplies.current).messages)
                        .filter(block => !previousIds.has(block.id)).length
                    return true
                })
                if (!applied) return { kind: 'stopped', reason: 'exhausted' }
                setViewMode('history')
                return { kind: 'applied', historyVersion: appliedVersion, hasMore: applied.hasMore, addedRenderableCount }
            }}
            onLocateNativeHistoryTurn={async (turnId, itemId, targetMessageId, isCurrent = () => true) => {
                const found = await thread.seekTurn(turnId, itemId, entries => isCurrent() && containsOutlineTarget(entries, targetMessageId))
                if (found) {
                    setViewMode('history')
                }
                return found
            }}
            onLoadMore={async (beforeApply) => {
                let appliedVersion = revision.current.value
                let addedRenderableCount = 0
                const blocks = (messages: typeof projected.messages) =>
                    reduceChatBlocks(
                        messages
                            .map(normalizeDecryptedMessage)
                            .filter((message): message is NormalizedMessage => message !== null),
                        { requests: projected.requests }
                    ).blocks
                const previousIds = new Set(blocks(projected.messages).map((block) => block.id))
                const applied = await thread.older((entries) => {
                    appliedVersion = revision.current.value + 1
                    if (beforeApply && !beforeApply(appliedVersion)) return false
                    addedRenderableCount = blocks(
                        projectNativeItems(
                            entries,
                            thread.requests,
                            turnStateKnown,
                            observedReplies.current
                        ).messages
                    ).filter((block) => !previousIds.has(block.id)).length
                    return true
                })
                if (!applied) return { kind: 'stopped', reason: 'exhausted' }
                setViewMode('history')
                return {
                    kind: 'applied',
                    historyVersion: appliedVersion,
                    hasMore: Boolean(applied.nextCursor),
                    addedRenderableCount,
                }
            }}
            onViewModeChange={(mode) => {
                setViewMode(mode)
                if (mode === 'tail') void thread.latest(true)
                else thread.browseHistory()
            }}
            onSend={async (text, attachments, scheduledAt, deliveryMode) => {
                if (sending || unavailable) return false
                if (scheduledAt) throw new Error('Native scheduled messages are unavailable')
                const attemptId = crypto.randomUUID()
                const annotated = splitResponseAnnotations(text)
                const command = parseCodexThreadCommand(annotated.body)
                if (!command && /^\s*\/(compact|recap|usage|approve)(?:\s|$)/i.test(annotated.body)) {
                    commands.reportError(t('nativeManagement.invalidArguments'))
                    return false
                }
                if (command && (command.command !== 'plan' || !command.prompt)) {
                    commands.reportError(t('nativeCommands.managementOnly'))
                    return false
                }
                if (command && unconfirmedPlan.current === text) { commands.reportError(t('nativeCommands.unconfirmed')); return false }
                let commandPosted = false
                setSending(true)
                setSendError(null)
                try {
                    if (command?.command === 'plan' && command.prompt) {
                        const prompt = await nativeThreadReferenceMessage(api, native, serializeResponseAnnotations(command.prompt, annotated.annotations))
                        commandPosted = true
                        await commands.execute({ command: { ...command, prompt }, clientId: attemptId,
                            ...(attachments?.length ? { attachments: attachments.map(({ path }) => ({ path })) } : {}) })
                        setSettlement({ attemptId, status: 'success' })
                        void thread.latest(); void queue.refresh()
                        return { attemptId }
                    }
                    const expectedTurnId =
                        deliveryMode === 'steer'
                            ? nativeAsyncReplyTurn(thread.detail.activeTurn)
                            : undefined
                    if (deliveryMode === 'steer' && !expectedTurnId)
                        throw new Error('No active native turn to steer')
                    const result = await api.codexNativeAction(native.threadId, 'messages', {
                        text: await nativeThreadReferenceMessage(api, native, text),
                        clientId: attemptId,
                        ...(attachments?.length ? { attachments } : {}),
                        ...(expectedTurnId ? { expectedTurnId } : {}),
                    })
                    setSettlement({ attemptId, status: 'success' })
                    if (result.startError)
                        setSendError({
                            id: Date.now(),
                            text: '',
                            message: `Accepted by Codex: ${String(result.startError)}`,
                            action: null,
                            scheduledAt: null,
                            mutationStarted: true,
                            restoreSuppressed: true,
                        })
                    void thread.latest()
                    void queue.refresh()
                    return { attemptId }
                } catch (error) {
                    if (error instanceof NativeCommandInactiveError) return false
                    const uncertain = commandPosted && (isNativeCommandSubmissionUnconfirmed(error) || !(error instanceof ApiError) || error.status >= 500)
                    if (uncertain) { unconfirmedPlan.current = text; void queue.refresh() }
                    setSettlement({ attemptId, status: 'error' })
                    setSendError({
                        id: Date.now(),
                        text,
                        message: uncertain ? t('nativeCommands.unconfirmed') : String(error),
                        action: uncertain ? { label: t('nativeCommands.allowRetry'), onClick: () => { unconfirmedPlan.current = null; setSendError(null) } } : null,
                        scheduledAt: null,
                        mutationStarted: true,
                        restoreSuppressed: false,
                    })
                    return false
                } finally {
                    setSending(false)
                }
            }}
            sendError={sendError}
            onClearSendError={() => setSendError(null)}
            initialOutlineOpen={outline}
        />
    )
}
