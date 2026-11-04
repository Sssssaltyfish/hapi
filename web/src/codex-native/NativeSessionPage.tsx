import { useCallback, useMemo, useRef, useState } from 'react'
import { SessionChat } from '@/components/SessionChat'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import type { ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { nativeAsyncReplyTurn, nativeQuestionReplies, nativeState, record } from './presentation'
import { projectNativeItems } from './projectNativeItems'
import { useNativeThread } from './useNativeThread'
import { createNativeSessionApiAdapter } from './nativeSessionApiAdapter'
import { useNativeSuggestions } from './useNativeSuggestions'
import { getConversationReadingPosition } from '@/lib/conversation-reading-position'
import { getTimelineBlockSourceIds } from '@/lib/assistant-runtime'
import { NativeApprovalSettings } from './NativeApprovalSettings'
import { useNativeQueue } from './useNativeQueue'
import { NativeQueuedMessagesBar } from './NativeQueuedMessagesBar'
import type { NativeItemEntry } from './types'
import type { TimelineHistoryLocator } from '@/lib/stable-chat-timeline'
import { useQuery } from '@tanstack/react-query'
import { useSessions } from '@/hooks/queries/useSessions'
import { nativeThreadReferenceMessage } from './nativeThreadReferences'

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
            key={`${native.endpointId}:${native.threadId}`}
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
    const queue = useNativeQueue(api, native.threadId, native.available !== false, thread.subscribeEvents)
    const { sessions: mentionSessions } = useSessions(api)
    const nativeEndpoints = useQuery({ queryKey: ['codex-native', 'endpoints'], queryFn: () => api.getCodexNativeEndpoints(), staleTime: 30_000, retry: false })
    const autocompleteSuggestions = useNativeSuggestions(api, native.threadId, {
        endpointId: native.endpointId, sessions: mentionSessions, endpoints: nativeEndpoints.data?.endpoints ?? [],
    })
    const observedReplies = useRef(new Map<string, string>())
    for (const [id, answer] of nativeQuestionReplies(thread.items))
        observedReplies.current.set(id, answer)
    while (observedReplies.current.size > 300)
        observedReplies.current.delete(observedReplies.current.keys().next().value!)
    const turnStateKnown = thread.detail.activeTurn !== undefined
    const projected = useMemo(
        () =>
            projectNativeItems(
                thread.items,
                thread.requests,
                turnStateKnown,
                observedReplies.current
            ),
        [thread.items, thread.requests, turnStateKnown]
    )
    const [sending, setSending] = useState(false)
    const historyLocators = useMemo(() => {
        const locators = new Map<string, TimelineHistoryLocator>()
        for (const entry of thread.items) {
            if (!entry.turnId) continue
            const locator: TimelineHistoryLocator = { kind: 'native', turnId: entry.turnId, itemId: entry.item.id }
            for (const suffix of ['', ':call', ':result']) locators.set(`native:${entry.item.id}${suffix}`, locator)
        }
        return locators
    }, [thread.items])
    const [settlement, setSettlement] = useState<SendMessageSettlement | null>(null)
    const [sendError, setSendError] = useState<ComposerSendError | null>(null)
    const [settingsError, setSettingsError] = useState<string | null>(null)
    const [viewMode, setViewMode] = useState<'tail' | 'history'>(() => getConversationReadingPosition(session.id)?.atBottom === false ? 'history' : 'tail')
    const revision = useRef({ items: thread.items, value: 0 })
    if (revision.current.items !== thread.items)
        revision.current = { items: thread.items, value: revision.current.value + 1 }
    const detail = record(thread.detail.thread)
    const settings = record(thread.detail.threadSettings ?? thread.detail)
    const activeTurn = record(thread.detail.activeTurn)
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
                typeof (settings.effort ?? settings.reasoningEffort) === 'string'
                    ? String(settings.effort ?? settings.reasoningEffort)
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
    const adapter = useMemo(
        () =>
            createNativeSessionApiAdapter(api, {
                session,
                liveSession,
                thread,
                projected,
                setSettingsError,
            }),
        [
            api,
            native.threadId,
            session.id,
            projected.requests,
            thread.requests,
            thread.detail.activeTurn,
            thread.refreshDetail,
            thread.applySettings,
            liveSession.model,
            liveSession.modelReasoningEffort,
        ]
    )
    return (
        <SessionChat
            api={adapter}
            autocompleteSuggestions={autocompleteSuggestions}
            session={liveSession}
            nativeCapabilities={{
                available: !unavailable,
                connected: thread.connected,
                queueContent: <NativeQueuedMessagesBar key={native.threadId} api={api} threadId={native.threadId} queue={queue} connected={thread.connected}
                    activeTurnId={activeTurn.status === 'inProgress' && typeof activeTurn.id === 'string' ? activeTurn.id : null} />,
                approvalSettings: <NativeApprovalSettings
                    settings={settings}
                    disabled={unavailable || !thread.connected}
                    onChange={adapter.setNativeApprovalSettings}
                />,
            }}
            messages={projected.messages}
            historyLocators={historyLocators}
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
                setSending(true)
                setSendError(null)
                try {
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
                    setSettlement({ attemptId, status: 'error' })
                    setSendError({
                        id: Date.now(),
                        text,
                        message: String(error),
                        action: null,
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
