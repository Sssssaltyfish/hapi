import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { aggregateResponseGroups } from '@/lib/assistant-runtime'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import {
    HISTORY_WINDOW_SIZE,
    INITIAL_PAGE_SIZE,
    VISIBLE_WINDOW_SIZE,
    activateMessageWindow,
    appendOptimisticMessage,
    cancelOlderMessageLoad,
    clearMessageWindow,
    fetchOlderMessages,
    fetchNewerMessages,
    prefetchMessageHistory,
    hasNewerMessagesOutsideWindow,
    getMessageWindowState,
    getQueuedReconcileCandidateLocalIds,
    ingestIncomingMessages,
    invalidateMessageWindow,
    markMessagesConsumed,
    markMessagesDispatching,
    markMessagesIndeterminate,
    markMessagesRequeued,
    reconcileQueuedLocalIds,
    removeOptimisticMessage,
    rewindMessageWindow,
    seekMessageWindow,
    setMessageViewMode,
    syncTailMessages,
    updateMessageStatus,
} from '@/lib/message-window-store'
import { saveConversationReadingPosition } from '@/lib/conversation-reading-position'

const touchedSessions = new Set<string>()

function sessionId(name: string): string {
    const id = `message-window-v2-${name}`
    touchedSessions.add(id)
    return id
}

function makeUserMessage(props: {
    id: string
    seq?: number | null
    localId?: string | null
    createdAt?: number
    invokedAt?: number | null
    status?: DecryptedMessage['status']
    scheduledAt?: number | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq ?? null,
        localId: props.localId ?? null,
        content: {
            role: 'user',
            content: { type: 'text', text: props.id }
        },
        createdAt: props.createdAt ?? 1_000,
        invokedAt: props.invokedAt,
        scheduledAt: props.scheduledAt,
        status: props.status,
        originalText: props.id
    } as DecryptedMessage
}

function makeAgentMessage(props: {
    id: string
    seq: number
    at: number
    invokedAt?: number | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: props.id }
            }
        },
        createdAt: props.at,
        invokedAt: props.invokedAt !== undefined ? props.invokedAt : props.at
    } as DecryptedMessage
}

function makeHiddenAgentMessage(props: { id: string; seq: number; at: number }): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'system', isMeta: true }
            }
        },
        createdAt: props.at,
        invokedAt: props.at
    } as DecryptedMessage
}

function makeReasoningMessage(id: string, streamId: string, seq: number, at: number, live = true): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'reasoning', message: id, id: streamId, ...(live ? { live: true } : {}) }
            }
        },
        createdAt: at,
        invokedAt: at
    } as DecryptedMessage
}

function makeAgentRunMessage(id: string, seq: number, at: number): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'agent-run-update',
                    cardId: 'card-1',
                    agentId: 'agent-1',
                    status: 'running',
                    activity: id
                }
            }
        },
        createdAt: at,
        invokedAt: at
    } as DecryptedMessage
}

function latestResponse(
    messages: DecryptedMessage[],
    options: {
        limit?: number
        epoch?: number
        hasMore?: boolean
        reset?: boolean
        nextBeforeAt?: number | null
        nextBeforeSeq?: number | null
        snapshotHeadAt?: number | null
        snapshotHeadSeq?: number | null
    } = {}
): MessagesResponse {
    const newest = [...messages]
        .filter((message) => typeof message.seq === 'number')
        .sort((left, right) => (left.invokedAt ?? left.createdAt) - (right.invokedAt ?? right.createdAt))
        .at(-1)
    return {
        messages,
        page: {
            direction: 'latest',
            limit: options.limit ?? 200,
            epoch: options.epoch ?? 0,
            reset: options.reset ?? false,
            nextBeforeAt: options.nextBeforeAt ?? null,
            nextBeforeSeq: options.nextBeforeSeq ?? null,
            nextAfterAt: null,
            nextAfterSeq: null,
            snapshotHeadAt: options.snapshotHeadAt
                ?? (newest ? newest.invokedAt ?? newest.createdAt : null),
            snapshotHeadSeq: options.snapshotHeadSeq
                ?? (typeof newest?.seq === 'number' ? newest.seq : null),
            hasMore: options.hasMore ?? false
        }
    }
}

function afterResponse(
    messages: DecryptedMessage[],
    options: {
        epoch?: number
        hasMore?: boolean
        nextAfterAt: number
        nextAfterSeq: number
        snapshotHeadAt: number
        snapshotHeadSeq: number
    }
): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'after',
            limit: 200,
            epoch: options.epoch ?? 0,
            reset: false,
            nextBeforeAt: null,
            nextBeforeSeq: null,
            nextAfterAt: options.nextAfterAt,
            nextAfterSeq: options.nextAfterSeq,
            snapshotHeadAt: options.snapshotHeadAt,
            snapshotHeadSeq: options.snapshotHeadSeq,
            hasMore: options.hasMore ?? false
        }
    }
}

function beforeResponse(
    messages: DecryptedMessage[],
    options: {
        epoch?: number
        hasMore?: boolean
        nextBeforeAt: number | null
        nextBeforeSeq: number | null
    }
): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'before',
            limit: 200,
            epoch: options.epoch ?? 0,
            reset: false,
            nextBeforeAt: options.nextBeforeAt,
            nextBeforeSeq: options.nextBeforeSeq,
            nextAfterAt: null,
            nextAfterSeq: null,
            snapshotHeadAt: null,
            snapshotHeadSeq: null,
            hasMore: options.hasMore ?? false
        }
    }
}

function createApi(getMessages: ApiClient['getMessages']): ApiClient {
    return { getMessages } as ApiClient
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

afterEach(() => {
    for (const id of touchedSessions) {
        clearMessageWindow(id)
    }
    touchedSessions.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
})

function makeToolMessages(count: number, firstSeq: number): DecryptedMessage[] {
    return Array.from({ length: count }, (_, index) => {
        const seq = firstSeq + index
        const callId = `call-${Math.floor(index / 2)}`
        return {
            id: `tool-${seq}`,
            seq,
            localId: null,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: index % 2 === 0
                        ? { type: 'tool-call', callId, name: 'Read', input: { file_path: `/f${index}` } }
                        : { type: 'tool-call-result', callId, output: 'ok' }
                }
            },
            createdAt: seq * 1_000,
            invokedAt: seq * 1_000
        } as DecryptedMessage
    })
}

describe('message tail synchronization', () => {
    it('fetches one older context page before first paint when the cold page is tool-only', async () => {
        const id = sessionId('cold-tool-only-context')
        const tools = makeToolMessages(INITIAL_PAGE_SIZE, 10)
        const context = makeAgentMessage({ id: 'context', seq: 9, at: 9_000 })
        const older = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse(tools, {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockReturnValueOnce(older.promise)

        const syncing = syncTailMessages(createApi(getMessages), id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        expect(getMessages.mock.calls[1]?.[1]).toEqual({ beforeAt: 10_000, beforeSeq: 10, limit: 200 })
        expect(getMessageWindowState(id)).toMatchObject({ isSyncingTail: true, messages: [] })

        older.resolve(beforeResponse([context], {
            epoch: 1,
            hasMore: true,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))
        await syncing

        const state = getMessageWindowState(id)
        expect(state.isSyncingTail).toBe(false)
        expect(state.hasMore).toBe(true)
        expect(state.messages.map((message) => message.id)).toEqual([
            'context',
            ...tools.map((message) => message.id)
        ])
    })

    it('releases a tool-only cold page when the context page exceeds the wait budget', async () => {
        vi.useFakeTimers()
        try {
            const id = sessionId('cold-tool-only-timeout')
            const tools = makeToolMessages(INITIAL_PAGE_SIZE, 10)
            const getMessages = vi.fn()
                .mockResolvedValueOnce(latestResponse(tools, {
                    epoch: 1,
                    hasMore: true,
                    nextBeforeAt: 10_000,
                    nextBeforeSeq: 10
                }))
                .mockReturnValueOnce(new Promise(() => {}))

            const syncing = syncTailMessages(createApi(getMessages), id)
            await vi.advanceTimersByTimeAsync(500)
            await syncing

            const state = getMessageWindowState(id)
            expect(state.isSyncingTail).toBe(false)
            expect(state.messages).toHaveLength(INITIAL_PAGE_SIZE)
        } finally {
            vi.useRealTimers()
        }
    })

    it('ignores queued prompts when classifying a tool-only cold page', async () => {
        const id = sessionId('cold-tool-only-queued')
        const tools = makeToolMessages(INITIAL_PAGE_SIZE, 10)
        const queued = makeUserMessage({ id: 'queued', localId: 'queued', createdAt: 99_000, invokedAt: null })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([...tools, queued], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([], { epoch: 1, nextBeforeAt: null, nextBeforeSeq: null }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(2)
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('queued')
    })

    it('does not fetch context on cached re-entry with a tool-only latest page', async () => {
        const id = sessionId('reentry-tool-only')
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [makeAgentMessage({ id: 'cached', seq: 5, at: 5_000 })],
            hasMore: true,
            oldestPositionAt: 5_000,
            oldestPositionSeq: 5,
            newestPositionAt: 5_000,
            newestPositionSeq: 5,
            epoch: 1
        }))
        activateMessageWindow(id)
        const getMessages = vi.fn().mockResolvedValueOnce(latestResponse(makeToolMessages(INITIAL_PAGE_SIZE, 10), {
            epoch: 1,
            hasMore: true,
            nextBeforeAt: 10_000,
            nextBeforeSeq: 10
        }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
    })

    it('does not fetch context when the cold page has conversation text', async () => {
        const id = sessionId('cold-text-no-context')
        const messages = [
            makeAgentMessage({ id: 'text', seq: 9, at: 9_000 }),
            ...makeToolMessages(INITIAL_PAGE_SIZE - 1, 10)
        ]
        const getMessages = vi.fn().mockResolvedValueOnce(latestResponse(messages, {
            epoch: 1,
            hasMore: true,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessageWindowState(id).messages).toHaveLength(INITIAL_PAGE_SIZE)
    })

    it('uses a small cold latest page while keeping older loads at full page size', async () => {
        const id = sessionId('cold-initial-page')
        const latestMessages = Array.from({ length: INITIAL_PAGE_SIZE }, (_, index) =>
            makeAgentMessage({
                id: `latest-${index + 1}`,
                seq: index + 1,
                at: (index + 1) * 1_000
            })
        )
        const older = makeAgentMessage({ id: 'older', seq: 0, at: 0 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse(latestMessages, {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 1_000,
                nextBeforeSeq: 1
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 1,
                hasMore: false,
                nextBeforeAt: 0,
                nextBeforeSeq: 0
            }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
        expect(getMessageWindowState(id).messages).toHaveLength(INITIAL_PAGE_SIZE)

        await fetchOlderMessages(api, id)

        expect(getMessages).toHaveBeenLastCalledWith(id, {
            beforeAt: 1_000,
            beforeSeq: 1,
            limit: 200
        }, expect.any(AbortSignal))
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'older',
            ...latestMessages.map((message) => message.id)
        ])
    })

    it('removes the rewound suffix immediately and applies duplicate invalidations once', async () => {
        const id = sessionId('rewind-suffix')
        const prefix = makeAgentMessage({ id: 'prefix', seq: 1, at: 1_000 })
        const target = makeUserMessage({
            id: 'target',
            seq: 2,
            localId: 'target-local-id',
            createdAt: 2_000,
            invokedAt: 2_000
        })
        const suffix = makeAgentMessage({ id: 'suffix', seq: 3, at: 3_000 })
        const getMessages = vi.fn(async () => latestResponse([prefix, target, suffix], { epoch: 1 }))

        await syncTailMessages(createApi(getMessages), id)
        rewindMessageWindow(id, 'target-local-id')
        rewindMessageWindow(id, 'target-local-id')

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['prefix'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)
    })

    it('clears the window when the rewind boundary is outside the loaded page', async () => {
        const id = sessionId('rewind-boundary-not-loaded')
        const current = makeAgentMessage({ id: 'current', seq: 40, at: 40_000 })
        const getMessages = vi.fn(async () => latestResponse([current], { epoch: 1 }))

        await syncTailMessages(createApi(getMessages), id)
        rewindMessageWindow(id, 'boundary-not-loaded')

        expect(getMessageWindowState(id).messages).toEqual([])
    })

    it('deduplicates delayed rewind events across consecutive boundaries', async () => {
        const id = sessionId('rewind-delayed-event')
        const prefix = makeAgentMessage({ id: 'prefix', seq: 1, at: 1_000 })
        const firstBoundary = makeUserMessage({
            id: 'first-boundary',
            seq: 2,
            localId: 'first-boundary-local-id',
            createdAt: 2_000,
            invokedAt: 2_000
        })
        const secondBoundary = makeUserMessage({
            id: 'second-boundary',
            seq: 3,
            localId: 'second-boundary-local-id',
            createdAt: 3_000,
            invokedAt: 3_000
        })
        const suffix = makeAgentMessage({ id: 'suffix', seq: 4, at: 4_000 })
        const getMessages = vi.fn(async () => latestResponse(
            [prefix, firstBoundary, secondBoundary, suffix],
            { epoch: 1 }
        ))

        await syncTailMessages(createApi(getMessages), id)
        rewindMessageWindow(id, 'second-boundary-local-id')
        rewindMessageWindow(id, 'first-boundary-local-id')
        rewindMessageWindow(id, 'second-boundary-local-id')

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['prefix'])
    })

    it('retains the current window while a latest reset is in flight', async () => {
        const id = sessionId('invalidation-preserves-window')
        const current = makeAgentMessage({ id: 'current', seq: 10, at: 10_000 })
        const latest = makeAgentMessage({ id: 'latest', seq: 20, at: 20_000 })
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([current], { epoch: 1 }))
            .mockImplementationOnce(async () => await response.promise)
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        invalidateMessageWindow(id)

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['current'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        expect(getMessages.mock.calls[1]?.[1]).toEqual({ limit: 200 })

        response.resolve(latestResponse([latest], { epoch: 2 }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(false)
    })

    it('renders a persisted window immediately, then requests a small latest tail on re-entry', async () => {
        const id = sessionId('reentry')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['cached'])
        setMessageViewMode(id, 'history')
        activateMessageWindow(id)
        expect(getMessageWindowState(id).viewMode).toBe('tail')

        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await response.promise)
        const syncing = syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['cached'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)

        const latest = makeAgentMessage({ id: 'latest', seq: 2_040, at: 2_040_000 })
        response.resolve(latestResponse([latest], {
            limit: 20,
            epoch: 3,
            hasMore: true,
            nextBeforeAt: 1_841_000,
            nextBeforeSeq: 1_841
        }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])
        expect(getMessageWindowState(id).hasMore).toBe(true)
        expect('pending' in getMessageWindowState(id)).toBe(false)
    })

    it('retains Codex round duration through persisted re-entry and a user-free latest tail', async () => {
        const id = sessionId('codex-round-duration')
        const tail: DecryptedMessage[] = [
            { type: 'message', message: 'completed answer' },
            { type: 'token_count', flavor: 'codex', model: 'gpt-5.4',
                info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
            { type: 'turn_duration', flavor: 'codex', durationMs: 39_426 }
        ].map((data, index) => ({ id: `round-${index}`, seq: 40 + index, localId: null,
            createdAt: 40_000 + index, content: { role: 'agent', content: { type: 'codex', data: { ...data, turn_id: 'round' } } } }))
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: tail, hasMore: true, oldestPositionAt: 40_000, oldestPositionSeq: 40,
            newestPositionAt: 40_002, newestPositionSeq: 42, epoch: 3
        }))
        const assertDuration = () => {
            const messages = getMessageWindowState(id).messages
            expect(messages.map(message => message.id)).toEqual(['round-0', 'round-1', 'round-2'])
            const normalized = messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
            const { blocks } = reduceChatBlocks(normalized, null)
            const visible = buildVisibleChatBlocks(blocks, { hasMoreMessages: true })
            expect(aggregateResponseGroups(visible).get('round-0:0')?.roundSummary).toMatchObject({
                durationMs: 39_426, numTurns: 1, usage: { input_tokens: 100, output_tokens: 10 }
            })
        }
        assertDuration()
        activateMessageWindow(id)
        const getMessages = vi.fn(async () => latestResponse(JSON.parse(JSON.stringify(tail)) as DecryptedMessage[], {
            epoch: 3, limit: 20, hasMore: true, nextBeforeAt: 40_000, nextBeforeSeq: 40
        }))
        await syncTailMessages(createApi(getMessages), id)
        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
        assertDuration()
    })

    it('preserves queued rows while replacing stale server rows on re-entry', async () => {
        const id = sessionId('reentry-queued')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 4_000 })
        const queued = makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 4_100,
            invokedAt: null,
            status: 'queued'
        })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached, queued],
            hasMore: true,
            oldestPositionAt: 4_000,
            oldestPositionSeq: 40,
            newestPositionAt: 4_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        activateMessageWindow(id)
        const latest = makeAgentMessage({ id: 'latest', seq: 2_000, at: 200_000 })
        const getMessages = vi.fn(async () => latestResponse([latest], { epoch: 3 }))
        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'local-1',
            'latest'
        ])
        expect(getMessageWindowState(id).messages).toContainEqual(expect.objectContaining({
            id: 'local-1',
            status: 'queued'
        }))
    })

    it('keeps the latest page cursor available for older history after re-entry', async () => {
        const id = sessionId('reentry-older-history')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        activateMessageWindow(id)
        const latest = [
            makeAgentMessage({ id: 'latest-1', seq: 2_039, at: 2_039_000 }),
            makeAgentMessage({ id: 'latest-2', seq: 2_040, at: 2_040_000 })
        ]
        const older = makeAgentMessage({ id: 'older', seq: 2_038, at: 2_038_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse(latest, {
                limit: 20,
                epoch: 3,
                hasMore: true,
                nextBeforeAt: 2_039_000,
                nextBeforeSeq: 2_039
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 3,
                hasMore: false,
                nextBeforeAt: 2_038_000,
                nextBeforeSeq: 2_038
            }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        await fetchOlderMessages(api, id)

        expect(getMessages.mock.calls[0]?.[1]).toEqual({ limit: 20 })
        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            beforeAt: 2_039_000,
            beforeSeq: 2_039,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'older',
            'latest-1',
            'latest-2'
        ])
    })

    it('keeps cached messages visible when the re-entry refresh fails', async () => {
        const id = sessionId('reentry-refresh-failure')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        activateMessageWindow(id)
        const getMessages = vi.fn(async () => {
            throw new Error('latest tail unavailable')
        })

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
        expect(getMessageWindowState(id)).toMatchObject({
            messages: [cached],
            isSyncingTail: false,
            warning: 'latest tail unavailable'
        })
    })

    it('preserves live and optimistic rows that arrive during a re-entry refresh', async () => {
        const id = sessionId('reentry-concurrent-rows')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        activateMessageWindow(id)
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await response.promise)
        const syncing = syncTailMessages(createApi(getMessages), id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 }))

        const optimistic = makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 41_000,
            invokedAt: null,
            status: 'sending'
        })
        appendOptimisticMessage(id, optimistic)
        const live = makeAgentMessage({ id: 'live', seq: 41, at: 41_000 })
        ingestIncomingMessages(id, [live])

        response.resolve(latestResponse([
            makeAgentMessage({ id: 'latest', seq: 2_040, at: 2_040_000 })
        ], { limit: 20, epoch: 3 }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'live',
            'local-1',
            'latest'
        ])
    })

    it('keeps incremental synchronization for non-activation refreshes', async () => {
        const id = sessionId('incremental-refresh')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        const latest = makeAgentMessage({ id: 'latest', seq: 41, at: 41_000 })
        const getMessages = vi.fn(async () => afterResponse([latest], {
            epoch: 3,
            nextAfterAt: 41_000,
            nextAfterSeq: 41,
            snapshotHeadAt: 41_000,
            snapshotHeadSeq: 41
        }))
        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, {
            afterAt: 40_000,
            afterSeq: 40,
            untilAt: null,
            untilSeq: null,
            epoch: 3,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'cached',
            'latest'
        ])
    })

    it('preserves SSE rows that arrive while the latest snapshot is in flight', async () => {
        const id = sessionId('latest-sse-race')
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await response.promise)
        const syncing = syncTailMessages(createApi(getMessages), id)

        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 2, at: 2_000 })
        ])
        response.resolve(latestResponse([
            makeAgentMessage({ id: 'snapshot', seq: 1, at: 1_000 })
        ], { epoch: 1 }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'snapshot',
            'concurrent'
        ])
        expect(getMessageWindowState(id).newestSeq).toBe(2)
    })

    it('reconciles an optimistic send echoed by an in-flight latest response', async () => {
        const id = sessionId('latest-optimistic-echo')
        const response = deferred<MessagesResponse>()
        const syncing = syncTailMessages(createApi(vi.fn(async () => await response.promise)), id)
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 1_000,
            invokedAt: null,
            status: 'sending'
        }))

        response.resolve(latestResponse([
            makeUserMessage({
                id: 'server-1',
                seq: 1,
                localId: 'local-1',
                createdAt: 1_000,
                invokedAt: null
            })
        ], { epoch: 1 }))
        await syncing

        expect(getMessageWindowState(id).messages).toEqual([
            expect.objectContaining({
                id: 'server-1',
                localId: 'local-1',
                status: 'sending'
            })
        ])
    })

    it('uses the oldest retained row after a latest and SSE merge trims the window', async () => {
        const id = sessionId('latest-sse-trim-cursor')
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await response.promise)
            .mockResolvedValueOnce(beforeResponse([], {
                epoch: 1,
                hasMore: false,
                nextBeforeAt: null,
                nextBeforeSeq: null
            }))
        const api = createApi(getMessages)
        const syncing = syncTailMessages(api, id)

        ingestIncomingMessages(id, Array.from({ length: 450 }, (_, index) => {
            const seq = index + 201
            return makeAgentMessage({ id: `concurrent-${seq}`, seq, at: seq })
        }))
        response.resolve(latestResponse(
            Array.from({ length: 200 }, (_, index) => {
                const seq = index + 1
                return makeAgentMessage({ id: `snapshot-${seq}`, seq, at: seq })
            }),
            {
                epoch: 1,
                hasMore: false,
                nextBeforeAt: 1,
                nextBeforeSeq: 1
            }
        ))
        await syncing

        await fetchOlderMessages(api, id)

        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            beforeAt: 251,
            beforeSeq: 251,
            limit: 200
        })
    })

    it('commits each forward page before the next page resolves', async () => {
        const id = sessionId('page-commit')
        const initial = makeAgentMessage({ id: 'initial', seq: 1, at: 1_000 })
        const firstDelta = makeAgentMessage({ id: 'delta-1', seq: 2, at: 2_000 })
        const secondDelta = makeAgentMessage({ id: 'delta-2', seq: 3, at: 3_000 })
        const secondPage = deferred<MessagesResponse>()
        let call = 0
        const getMessages = vi.fn(async () => {
            call += 1
            if (call === 1) return latestResponse([initial], { epoch: 1 })
            if (call === 2) {
                return afterResponse([firstDelta], {
                    epoch: 1,
                    nextAfterAt: 2_000,
                    nextAfterSeq: 2,
                    snapshotHeadAt: 3_000,
                    snapshotHeadSeq: 3,
                    hasMore: true
                })
            }
            return await secondPage.promise
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => {
            expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('delta-1')
            expect(getMessages).toHaveBeenCalledTimes(3)
        })
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)

        secondPage.resolve(afterResponse([secondDelta], {
            epoch: 1,
            nextAfterAt: 3_000,
            nextAfterSeq: 3,
            snapshotHeadAt: 3_000,
            snapshotHeadSeq: 3
        }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'initial',
            'delta-1',
            'delta-2'
        ])
    })

    it('keeps the newest SSE cursor when a forward page finishes behind it', async () => {
        const id = sessionId('forward-sse-cursor')
        const initial = makeAgentMessage({ id: 'initial', seq: 10, at: 1_000 })
        const stalePage = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([initial], { epoch: 5 }))
            .mockImplementationOnce(async () => await stalePage.promise)
            .mockResolvedValueOnce(afterResponse([], {
                epoch: 5,
                nextAfterAt: 1_200,
                nextAfterSeq: 12,
                snapshotHeadAt: 1_200,
                snapshotHeadSeq: 12
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 12, at: 1_200 })
        ])
        stalePage.resolve(afterResponse([
            makeAgentMessage({ id: 'page', seq: 11, at: 1_100 })
        ], {
            epoch: 5,
            nextAfterAt: 1_100,
            nextAfterSeq: 11,
            snapshotHeadAt: 1_100,
            snapshotHeadSeq: 11
        }))
        await syncing

        await syncTailMessages(api, id)

        expect(getMessages.mock.calls[2]?.[1]).toEqual({
            afterAt: 1_200,
            afterSeq: 12,
            untilAt: null,
            untilSeq: null,
            epoch: 5,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'initial',
            'page',
            'concurrent'
        ])
    })

    it('invalidates an in-flight incremental request when re-entry prioritizes latest', async () => {
        const id = sessionId('reentry-in-flight')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        const staleResponse = deferred<MessagesResponse>()
        const latest = makeAgentMessage({ id: 'latest', seq: 2_040, at: 2_040_000 })
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await staleResponse.promise)
            .mockResolvedValueOnce(latestResponse([latest], { epoch: 3 }))
        const api = createApi(getMessages)
        const initialSync = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1))

        activateMessageWindow(id)
        const reentrySync = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        expect(getMessages.mock.calls[1]?.[1]).toEqual({ limit: 20 })
        staleResponse.resolve(afterResponse([
            makeAgentMessage({ id: 'stale-page', seq: 41, at: 41_000 })
        ], {
            epoch: 3,
            nextAfterAt: 41_000,
            nextAfterSeq: 41,
            snapshotHeadAt: 2_040_000,
            snapshotHeadSeq: 2_040,
            hasMore: true
        }))

        await initialSync
        await reentrySync

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])
    })

    it('deduplicates SSE and REST delivery while preserving the authoritative invocation timestamp', async () => {
        const id = sessionId('dedupe')
        const initial = makeAgentMessage({ id: 'initial', seq: 1, at: 1_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([initial], { epoch: 2 }))
            .mockResolvedValueOnce(afterResponse([
                makeAgentMessage({ id: 'same', seq: 2, at: 1_500, invokedAt: null })
            ], {
                epoch: 2,
                nextAfterAt: 2_000,
                nextAfterSeq: 2,
                snapshotHeadAt: 2_000,
                snapshotHeadSeq: 2
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        ingestIncomingMessages(id, [makeAgentMessage({ id: 'same', seq: 2, at: 1_500, invokedAt: 2_000 })])
        await syncTailMessages(api, id)

        const matches = getMessageWindowState(id).messages.filter((message) => message.id === 'same')
        expect(matches).toHaveLength(1)
        expect(matches[0]?.invokedAt).toBe(2_000)
    })

    it('does not advance the tail cursor from an out-of-band consumed update', async () => {
        const id = sessionId('consumed-cursor-gap')
        const queued = makeUserMessage({
            id: 'queued',
            seq: 1,
            localId: 'local-1',
            createdAt: 1_000,
            invokedAt: null,
            status: 'queued'
        })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([queued], { epoch: 1 }))
            .mockResolvedValueOnce(afterResponse([
                makeAgentMessage({ id: 'missed', seq: 2, at: 2_000 })
            ], {
                epoch: 1,
                nextAfterAt: 3_000,
                nextAfterSeq: 1,
                snapshotHeadAt: 3_000,
                snapshotHeadSeq: 1
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        markMessagesConsumed(id, ['local-1'], 3_000)
        await syncTailMessages(api, id)

        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            afterAt: 1_000,
            afterSeq: 1,
            untilAt: null,
            untilSeq: null,
            epoch: 1,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'missed',
            'queued'
        ])
    })

    it('runs a guaranteed trailing request after an in-flight synchronization', async () => {
        const id = sessionId('trailing')
        const firstRequest = deferred<MessagesResponse>()
        const secondRequest = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await firstRequest.promise)
            .mockImplementationOnce(async () => await secondRequest.promise)
        const api = createApi(getMessages)

        const first = syncTailMessages(api, id)
        const trailing = syncTailMessages(api, id, { ensureAfterCurrent: true })
        expect(getMessages).toHaveBeenCalledTimes(1)

        firstRequest.resolve(latestResponse([
            makeAgentMessage({ id: 'first', seq: 1, at: 1_000 })
        ], { epoch: 1 }))
        await first
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))

        let trailingResolved = false
        void trailing.then(() => {
            trailingResolved = true
        })
        await Promise.resolve()
        expect(trailingResolved).toBe(false)

        secondRequest.resolve(afterResponse([], {
            epoch: 1,
            nextAfterAt: 1_000,
            nextAfterSeq: 1,
            snapshotHeadAt: 1_000,
            snapshotHeadSeq: 1
        }))
        await trailing
        expect(trailingResolved).toBe(true)
    })

    it('replaces stale server rows on epoch reset and preserves a not-yet-echoed optimistic send', async () => {
        const id = sessionId('epoch-reset')
        const old = makeAgentMessage({ id: 'old', seq: 1, at: 1_000 })
        const fresh = makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
        const optimistic = makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 1_500,
            invokedAt: null,
            status: 'sending'
        })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([old], { epoch: 1 }))
            .mockResolvedValueOnce(latestResponse([fresh], { epoch: 2, reset: true }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        appendOptimisticMessage(id, optimistic)

        await syncTailMessages(api, id)

        const state = getMessageWindowState(id)
        expect(state.messages.map((message) => message.id)).toEqual(['local-1', 'fresh'])
        expect(state.epoch).toBe(2)
    })

    it('preserves concurrent SSE and optimistic rows while applying an epoch reset', async () => {
        const id = sessionId('epoch-reset-sse-race')
        const old = makeAgentMessage({ id: 'old', seq: 1, at: 1_000 })
        const reset = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([old], { epoch: 1 }))
            .mockImplementationOnce(async () => await reset.promise)
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-reset',
            localId: 'local-reset',
            createdAt: 1_500,
            invokedAt: null,
            status: 'sending'
        }))

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 3, at: 3_000 })
        ])
        reset.resolve(latestResponse([
            makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
        ], { epoch: 2, reset: true }))
        await syncing

        const state = getMessageWindowState(id)
        expect(state.messages.map((message) => message.id)).toEqual([
            'local-reset',
            'fresh',
            'concurrent'
        ])
        expect(state.epoch).toBe(2)
        expect(state.newestSeq).toBe(3)
    })

    it('removes earlier HTTP pages when the epoch resets later in the same catch-up', async () => {
        const id = sessionId('mid-catch-up-reset')
        const reset = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'initial', seq: 1, at: 1_000 })
            ], { epoch: 1 }))
            .mockResolvedValueOnce(afterResponse([
                makeAgentMessage({ id: 'stale-page', seq: 2, at: 2_000 })
            ], {
                epoch: 1,
                nextAfterAt: 2_000,
                nextAfterSeq: 2,
                snapshotHeadAt: 3_000,
                snapshotHeadSeq: 3,
                hasMore: true
            }))
            .mockImplementationOnce(async () => await reset.promise)
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(3))
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 11, at: 11_000 })
        ])
        reset.resolve(latestResponse([
            makeAgentMessage({ id: 'fresh', seq: 10, at: 10_000 })
        ], { epoch: 2, reset: true }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'fresh',
            'concurrent'
        ])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('invalidates an old request when the window is cleared and reloaded', async () => {
        const id = sessionId('clear-generation')
        const stale = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await stale.promise)
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
            ], { epoch: 0 }))
        const api = createApi(getMessages)

        const oldSync = syncTailMessages(api, id)
        clearMessageWindow(id)
        await syncTailMessages(api, id)
        stale.reject(new Error('stale failure'))
        await oldSync

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).warning).toBeNull()
    })

    it('does not backfill older pages during the latest-tail request', async () => {
        const id = sessionId('no-cold-backfill')
        const traceRows = Array.from({ length: 200 }, (_, index) =>
            makeAgentRunMessage(`trace-${index}`, index + 101, index + 10_000)
        )
        const getMessages = vi.fn(async () => latestResponse(traceRows, {
            epoch: 0,
            hasMore: true,
            nextBeforeAt: 10_000,
            nextBeforeSeq: 101
        }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
        expect(getMessageWindowState(id).hasMore).toBe(true)
    })
})

describe('history view and older pagination', () => {
    it('rejects repeated cursors in both directions without changing the reader window', async () => {
        const id = sessionId('history-cursor-stalled')
        const current = makeUserMessage({ id: 'current', seq: 10, createdAt: 10000, invokedAt: 10000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(beforeResponse([current], { epoch: 1, hasMore: true, nextBeforeAt: 10000, nextBeforeSeq: 10 }))
            .mockResolvedValueOnce(beforeResponse([], { epoch: 1, hasMore: true, nextBeforeAt: 10000, nextBeforeSeq: 10 }))
            .mockResolvedValueOnce(afterResponse([], { epoch: 1, hasMore: true, nextAfterAt: 10000, nextAfterSeq: 10, snapshotHeadAt: 10000, snapshotHeadSeq: 10 }))
        const api = createApi(getMessages)
        await seekMessageWindow(api, id, { kind: 'runner', beforeAt: 11000, beforeSeq: 11, epoch: 1 }, 'user-text:current')
        expect(await fetchOlderMessages(api, id)).toMatchObject({ kind: 'failed' })
        expect(await fetchNewerMessages(api, id)).toMatchObject({ kind: 'failed' })
        expect(getMessageWindowState(id).messages).toEqual([current])
        expect(getMessageWindowState(id).isLoadingMore).toBe(false)
        expect(getMessages).toHaveBeenCalledTimes(3)
    })

    it('does not exhaust a newer observed tail when joining an older speculative end response', async () => {
        const id = sessionId('prefetch-moving-end')
        const current = makeUserMessage({ id: 'current', seq: 10, createdAt: 10000, invokedAt: 10000 })
        const arrived = makeUserMessage({ id: 'arrived', seq: 11, createdAt: 11000, invokedAt: 11000 })
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(beforeResponse([current], { epoch: 1, hasMore: true, nextBeforeAt: 10000, nextBeforeSeq: 10 }))
            .mockReturnValueOnce(response.promise)
            .mockResolvedValue(afterResponse([arrived], { epoch: 1, nextAfterAt: 11000, nextAfterSeq: 11, snapshotHeadAt: 11000, snapshotHeadSeq: 11 }))
        const api = createApi(getMessages)
        await seekMessageWindow(api, id, { kind: 'runner', beforeAt: 12000, beforeSeq: 12, epoch: 1 }, 'user-text:current')
        const warm = prefetchMessageHistory(api, id, 'newer')
        const demand = fetchNewerMessages(api, id)
        ingestIncomingMessages(id, [arrived])
        response.resolve(afterResponse([], { epoch: 1, nextAfterAt: 10000, nextAfterSeq: 10, snapshotHeadAt: 10000, snapshotHeadSeq: 10 }))
        await warm
        expect(await demand).toMatchObject({ kind: 'applied', hasMore: true })
        expect(hasNewerMessagesOutsideWindow(id)).toBe(true)
        expect(await fetchNewerMessages(api, id)).toMatchObject({ kind: 'applied', hasMore: false })
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['current', 'arrived'])
    })

    it('warms adjacent pages without changing the viewport and adopts an in-flight read at the edge', async () => {
        const id = sessionId('prefetch-adoption')
        const current = makeUserMessage({ id: 'current', seq: 20, createdAt: 20000, invokedAt: 20000 })
        const neighbor = makeUserMessage({ id: 'neighbor', seq: 19, createdAt: 19000, invokedAt: 19000 })
        ingestIncomingMessages(id, [current])
        setMessageViewMode(id, 'history')
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn().mockResolvedValueOnce(beforeResponse([current], { epoch: 1, hasMore: true, nextBeforeAt: 20000, nextBeforeSeq: 20 })).mockReturnValue(response.promise)
        const api = createApi(getMessages)
        await seekMessageWindow(api, id, { kind: 'runner', beforeAt: 21000, beforeSeq: 21, epoch: 1 }, 'user-text:current')
        const baseline = getMessageWindowState(id)
        const warm = prefetchMessageHistory(api, id, 'older')
        expect(getMessageWindowState(id)).toBe(baseline)
        const demand = fetchOlderMessages(api, id)
        response.resolve(beforeResponse([neighbor], { epoch: 1, hasMore: false, nextBeforeAt: null, nextBeforeSeq: null }))
        await warm
        expect((await demand).kind).toBe('applied')
        expect(getMessages).toHaveBeenCalledTimes(2)
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['neighbor', 'current'])
    })

    it('keeps the continuous forward cursor separate from retained queue and isolated SSE tail rows', async () => {
        const id = sessionId('forward-boundary-isolation')
        ingestIncomingMessages(id, [makeUserMessage({ id: 'queued-tail', seq: 100, createdAt: 100000, invokedAt: null, status: 'queued' })])
        const getMessages = vi.fn()
            .mockResolvedValueOnce(beforeResponse([makeUserMessage({ id: 'middle', seq: 10, createdAt: 10000, invokedAt: 10000 })], { epoch: 1, hasMore: true, nextBeforeAt: 10000, nextBeforeSeq: 10 }))
            .mockResolvedValueOnce(afterResponse([makeUserMessage({ id: 'next', seq: 11, createdAt: 11000, invokedAt: 11000 })], { epoch: 1, hasMore: true, nextAfterAt: 11000, nextAfterSeq: 11, snapshotHeadAt: 101000, snapshotHeadSeq: 101 }))
            .mockResolvedValueOnce(afterResponse([makeUserMessage({ id: 'next-again', seq: 12, createdAt: 12000, invokedAt: 12000 })], { epoch: 1, hasMore: true, nextAfterAt: 12000, nextAfterSeq: 12, snapshotHeadAt: 101000, snapshotHeadSeq: 101 }))
        const api = createApi(getMessages)
        expect(await seekMessageWindow(api, id, { kind: 'runner', beforeAt: 20000, beforeSeq: 20, epoch: 1 }, 'user-text:middle')).toBe(true)
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'isolated-live-tail', seq: 101, at: 101000 })])
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['middle', 'queued-tail'])
        expect((await fetchNewerMessages(api, id)).kind).toBe('applied')
        expect(getMessages).toHaveBeenLastCalledWith(id, { afterAt: 10000, afterSeq: 10, epoch: 1, limit: 200 }, expect.any(AbortSignal))
        ingestIncomingMessages(id, [makeUserMessage({ id: 'queued-tail', seq: 100, createdAt: 100000, invokedAt: 100000 })])
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['middle', 'next'])
        expect((await fetchNewerMessages(api, id)).kind).toBe('applied')
        expect(getMessages).toHaveBeenLastCalledWith(id, { afterAt: 11000, afterSeq: 11, epoch: 1, limit: 200 }, expect.any(AbortSignal))
    })

    it('reads newer records back after older pagination evicts the tail, preserving a bounded continuous window', async () => {
        const id = sessionId('bidirectional-window')
        const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => {
            const seq = start + i
            return makeUserMessage({ id: `m-${seq}`, seq, createdAt: seq * 1000, invokedAt: seq * 1000 })
        })
        ingestIncomingMessages(id, range(1, 1200))
        setMessageViewMode(id, 'history')
        const getMessages = vi.fn()
            .mockResolvedValueOnce(beforeResponse(range(601, 800), { epoch: 1, hasMore: true, nextBeforeAt: 601000, nextBeforeSeq: 601 }))
            .mockResolvedValueOnce(beforeResponse(range(401, 600), { epoch: 1, hasMore: true, nextBeforeAt: 401000, nextBeforeSeq: 401 }))
            .mockResolvedValueOnce(beforeResponse(range(201, 400), { epoch: 1, hasMore: true, nextBeforeAt: 201000, nextBeforeSeq: 201 }))
            .mockResolvedValueOnce(afterResponse(range(1001, 1200), { epoch: 1, nextAfterAt: 1200000, nextAfterSeq: 1200, snapshotHeadAt: 1200000, snapshotHeadSeq: 1200 }))
        const api = createApi(getMessages)
        for (let i = 0; i < 3; i++) expect((await fetchOlderMessages(api, id)).kind).toBe('applied')
        expect(getMessageWindowState(id).messages.at(-1)?.id).toBe('m-1000')
        expect(hasNewerMessagesOutsideWindow(id)).toBe(true)
        const warmedCalls = getMessages.mock.calls.length
        expect((await fetchNewerMessages(api, id)).kind).toBe('applied')
        expect(getMessages).toHaveBeenCalledTimes(warmedCalls)
        expect(getMessages).toHaveBeenLastCalledWith(id, { afterAt: 1000000, afterSeq: 1000, epoch: 1, limit: 200 }, expect.any(AbortSignal))
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(range(401, 1200).map(message => message.id))
        expect(hasNewerMessagesOutsideWindow(id)).toBe(false)
        expect(getMessageWindowState(id).hasMore).toBe(true)
    })

    it('retains a history window on preview re-entry when its reading position is saved', () => {
        const id = sessionId('preview-reading-window')
        ingestIncomingMessages(id, [makeUserMessage({ id: 'reading', seq: 1, invokedAt: 1000 })])
        setMessageViewMode(id, 'history')
        saveConversationReadingPosition(id, { anchor: { id: 'hapi-message-user-text:reading', topOffset: 10 }, scrollTop: 200, atBottom: false })
        const messages = getMessageWindowState(id).messages
        activateMessageWindow(id)
        expect(getMessageWindowState(id).viewMode).toBe('history')
        expect(getMessageWindowState(id).messages).toBe(messages)
    })

    it('seeks a known prompt page directly and rejects stale epoch locators', async () => {
        const id = sessionId('outline-direct-seek')
        const getMessages = vi.fn().mockResolvedValue(beforeResponse([makeUserMessage({ id: 'indexed', seq: 10, invokedAt: 1000 })], { epoch: 4, hasMore: true, nextBeforeAt: 1000, nextBeforeSeq: 10 }))
        const api = createApi(getMessages)
        const locator = { kind: 'runner' as const, beforeAt: 2000, beforeSeq: 20, epoch: 4 }
        expect(await seekMessageWindow(api, id, locator, 'user-text:indexed')).toBe(true)
        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessages).toHaveBeenCalledWith(id, { beforeAt: 2000, beforeSeq: 20, limit: 200 })
        expect(getMessageWindowState(id).viewMode).toBe('history')
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['indexed'])
        expect(await seekMessageWindow(api, id, { ...locator, epoch: 3 }, 'user-text:indexed')).toBe(false)
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['indexed'])
        expect(getMessageWindowState(id).isLoadingMore).toBe(false)
    })

    it('does not publish an outline seek after navigation cancels its request', async () => {
        const id = sessionId('outline-cancelled-seek')
        ingestIncomingMessages(id, [makeUserMessage({ id: 'current', seq: 30, invokedAt: 1000 })])
        const response = deferred<MessagesResponse>()
        const api = createApi(vi.fn(() => response.promise))
        const seek = seekMessageWindow(api, id, { kind: 'runner', beforeAt: 2000, beforeSeq: 20, epoch: 4 }, 'user-text:indexed')
        cancelOlderMessageLoad(id)
        response.resolve(beforeResponse([makeUserMessage({ id: 'indexed', seq: 10, invokedAt: 1000 })], { epoch: 4, nextBeforeAt: null, nextBeforeSeq: null }))
        expect(await seek).toBe(false)
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['current'])
    })

    it('appends while reading history, then compacts at the tail', () => {
        const id = sessionId('history-unseen')
        const initial = Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) =>
            makeAgentMessage({ id: `initial-${index}`, seq: index + 1, at: index + 1 })
        )
        ingestIncomingMessages(id, initial)
        setMessageViewMode(id, 'history')

        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'new-1', seq: 401, at: 401 }),
            makeAgentMessage({ id: 'new-2', seq: 402, at: 402 })
        ])

        expect(getMessageWindowState(id).viewMode).toBe('history')
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('new-2')

        setMessageViewMode(id, 'tail')
        const state = getMessageWindowState(id)
        expect(state.viewMode).toBe('tail')
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.at(-1)?.id).toBe('new-2')
    })

    it('keeps rows dropped during tail compaction available to older pagination', async () => {
        const id = sessionId('tail-compaction-cursor')
        ingestIncomingMessages(id, Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) => {
            const seq = index + 1
            return makeAgentMessage({ id: `initial-${seq}`, seq, at: seq })
        }))
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'new-401', seq: 401, at: 401 }),
            makeAgentMessage({ id: 'new-402', seq: 402, at: 402 })
        ])

        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).hasMore).toBe(true)

        const getMessages = vi.fn(async () => beforeResponse([
            makeAgentMessage({ id: 'initial-1', seq: 1, at: 1 }),
            makeAgentMessage({ id: 'initial-2', seq: 2, at: 2 })
        ], {
            epoch: 0,
            hasMore: false,
            nextBeforeAt: 1,
            nextBeforeSeq: 1
        }))
        await fetchOlderMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, {
            beforeAt: 3,
            beforeSeq: 3,
            limit: 200
        }, expect.any(AbortSignal))
        expect(getMessageWindowState(id).messages).toHaveLength(VISIBLE_WINDOW_SIZE + 2)
    })

    it('falls back to a latest request after the bounded history window overflows', async () => {
        const id = sessionId('history-overflow')
        const initial = makeAgentMessage({ id: 'initial', seq: 1, at: 1 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([initial], { epoch: 1 }))
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'latest', seq: 1_000, at: 1_000 })
            ], { epoch: 1 }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        setMessageViewMode(id, 'history')

        ingestIncomingMessages(id, Array.from({ length: HISTORY_WINDOW_SIZE + 10 }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        ))
        expect(getMessageWindowState(id).messages).toHaveLength(HISTORY_WINDOW_SIZE)

        setMessageViewMode(id, 'tail')
        await syncTailMessages(api, id)

        expect(getMessages.mock.calls[1]?.[1]).toEqual({ limit: 200 })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('latest')
    })

    it('loads exactly one raw older page with the paired composite cursor', async () => {
        const id = sessionId('older-page')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const older = makeAgentMessage({ id: 'older', seq: 9, at: 9_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        await fetchOlderMessages(api, id)

        expect(getMessages).toHaveBeenCalledTimes(2)
        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            beforeAt: 10_000,
            beforeSeq: 10,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['older', 'latest'])
    })

    it('advances the tail revision for live messages but not older-page loads', async () => {
        const id = sessionId('tail-revision')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const older = makeAgentMessage({ id: 'older', seq: 9, at: 9_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        const afterTailSync = getMessageWindowState(id).tailRevision
        setMessageViewMode(id, 'history')
        await fetchOlderMessages(api, id)

        expect(getMessageWindowState(id).tailRevision).toBe(afterTailSync)

        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'new-live', seq: 11, at: 11_000 })
        ])

        expect(getMessageWindowState(id).tailRevision).toBe(afterTailSync + 1)
    })

    it('leaves the window unchanged when the final older-page apply check rejects', async () => {
        const id = sessionId('older-page-apply-rejected')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const older = makeAgentMessage({ id: 'older', seq: 9, at: 9_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        const before = getMessageWindowState(id)

        const onBeforeApply = vi.fn(() => false)
        const outcome = await fetchOlderMessages(api, id, { onBeforeApply })

        expect(onBeforeApply).toHaveBeenCalledWith(before.historyVersion + 1)
        expect(outcome).toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(id)).toMatchObject({
            messages: [latest],
            isLoadingMore: false,
            historyVersion: before.historyVersion
        })
    })

    it('advances through hidden older rows without retaining them in the visible window', async () => {
        const id = sessionId('hidden-older-page')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const hidden = makeHiddenAgentMessage({ id: 'hidden', seq: 9, at: 9_000 })
        const older = makeAgentMessage({ id: 'older', seq: 8, at: 8_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([hidden], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 8_000,
                nextBeforeSeq: 8
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const hiddenOutcome = await fetchOlderMessages(api, id)
        expect(hiddenOutcome).toMatchObject({
            kind: 'applied',
            addedRenderableCount: 0
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])

        const visibleOutcome = await fetchOlderMessages(api, id)
        expect(visibleOutcome).toMatchObject({
            kind: 'applied',
            addedRenderableCount: 1
        })
        expect(getMessages.mock.calls[2]?.[1]).toMatchObject({
            beforeAt: 9_000,
            beforeSeq: 9
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['older', 'latest'])
    })

    it('discards an older response invalidated by a concurrent epoch reset', async () => {
        const id = sessionId('older-reset-race')
        const older = deferred<MessagesResponse>()
        const getMessages = vi.fn(async (_sessionId: string, options?: Parameters<ApiClient['getMessages']>[1]) => {
            if (options?.beforeAt !== undefined) {
                return await older.promise
            }
            if (options?.afterAt !== undefined) {
                return latestResponse([
                    makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
                ], { epoch: 2, reset: true })
            }
            return latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            })
        }) as ApiClient['getMessages']
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadingOlder = fetchOlderMessages(api, id)
        await vi.waitFor(() => expect(getMessageWindowState(id).isLoadingMore).toBe(true))
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id)).toMatchObject({
            epoch: 2,
            isLoadingMore: false
        })

        older.resolve(beforeResponse([
            makeAgentMessage({ id: 'stale-older', seq: 9, at: 9_000 })
        ], {
            epoch: 1,
            hasMore: false,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))
        expect(await loadingOlder).toEqual({ kind: 'stopped', reason: 'invalidated' })

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('treats an invalidated older request rejection as a stopped load', async () => {
        const id = sessionId('older-rejection-after-reset')
        const older = deferred<MessagesResponse>()
        const getMessages = vi.fn(async (_sessionId: string, options?: Parameters<ApiClient['getMessages']>[1]) => {
            if (options?.beforeAt !== undefined) {
                return await older.promise
            }
            if (options?.afterAt !== undefined) {
                return latestResponse([
                    makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
                ], { epoch: 2, reset: true })
            }
            return latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            })
        }) as ApiClient['getMessages']
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadingOlder = fetchOlderMessages(api, id)
        await vi.waitFor(() => expect(getMessageWindowState(id).isLoadingMore).toBe(true))
        await syncTailMessages(api, id)

        older.reject(new Error('stale transport failure'))

        expect(await loadingOlder).toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(id).warning).toBeNull()
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
    })

    it('rejects an older page that resolves after a reset request starts but before it applies', async () => {
        const id = sessionId('older-before-reset-response')
        const older = deferred<MessagesResponse>()
        const reset = deferred<MessagesResponse>()
        const getMessages = vi.fn(async (_sessionId: string, options?: Parameters<ApiClient['getMessages']>[1]) => {
            if (options?.beforeAt !== undefined) {
                return await older.promise
            }
            if (options?.afterAt !== undefined) {
                return await reset.promise
            }
            return latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            })
        }) as ApiClient['getMessages']
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadingOlder = fetchOlderMessages(api, id)
        await vi.waitFor(() => expect(getMessageWindowState(id).isLoadingMore).toBe(true))
        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(3))

        older.resolve(beforeResponse([
            makeAgentMessage({ id: 'stale-older', seq: 9, at: 9_000 })
        ], {
            epoch: 1,
            hasMore: false,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))
        expect(await loadingOlder).toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['initial'])

        reset.resolve(latestResponse([
            makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
        ], { epoch: 2, reset: true }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('ends the current coverage run when an older page discovers a new epoch', async () => {
        const id = sessionId('older-epoch-mismatch')
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([], {
                epoch: 2,
                hasMore: false,
                nextBeforeAt: null,
                nextBeforeSeq: null
            }))
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
            ], { epoch: 2 }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadedOlderPage = await fetchOlderMessages(api, id)

        expect(loadedOlderPage).toEqual({ kind: 'stopped', reason: 'epoch-reset' })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('protects regular conversation rows from an agent-run flood', () => {
        const id = sessionId('agent-run-budget')
        const root = makeUserMessage({ id: 'root', seq: 1, invokedAt: 1, createdAt: 1 })
        ingestIncomingMessages(id, [
            root,
            ...Array.from({ length: VISIBLE_WINDOW_SIZE + 1 }, (_, index) =>
                makeAgentRunMessage(`run-${index}`, index + 2, index + 2)
            )
        ])

        expect(getMessageWindowState(id).messages.some((message) => message.id === 'root')).toBe(true)
    })
})

describe('optimistic and queued-message operations', () => {
    it('replaces an optimistic row by localId and updates status in the canonical collection', () => {
        const id = sessionId('optimistic-replace')
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            invokedAt: null,
            status: 'sending'
        }))
        ingestIncomingMessages(id, [makeUserMessage({
            id: 'server-1',
            seq: 1,
            localId: 'local-1',
            invokedAt: null
        })])
        updateMessageStatus(id, 'local-1', 'sent')

        expect(getMessageWindowState(id).messages).toHaveLength(1)
        expect(getMessageWindowState(id).messages[0]).toMatchObject({
            id: 'server-1',
            status: 'sent'
        })
    })

    it('keeps pending delivery outside history position and ignores stale pending after uncertainty or consumption', () => {
        const id = sessionId('steer-pending')
        ingestIncomingMessages(id, [makeUserMessage({ id: 'pending', localId: 'pending-local', seq: 1, invokedAt: null })])
        const before = getMessageWindowState(id)
        markMessagesRequeued(id, ['pending-local'])
        expect(getMessageWindowState(id).messages[0]).not.toBe(before.messages[0])
        markMessagesDispatching(id, ['pending-local'])
        expect(getMessageWindowState(id).messages[0]).toMatchObject({ invokedAt: null, deliveryState: 'dispatching' })
        expect(getMessageWindowState(id).tailRevision).toBe(before.tailRevision)
        expect(getMessageWindowState(id).newestSeq).toBe(before.newestSeq)
        markMessagesIndeterminate(id, ['pending-local'])
        markMessagesDispatching(id, ['pending-local'])
        expect(getMessageWindowState(id).messages[0].deliveryState).toBe('indeterminate')
        markMessagesRequeued(id, ['pending-local'])
        markMessagesDispatching(id, ['pending-local'])
        expect(getMessageWindowState(id).messages[0].deliveryState).toBe('dispatching')
        markMessagesConsumed(id, ['pending-local'], 3_000)
        markMessagesDispatching(id, ['pending-local'])
        expect(getMessageWindowState(id).messages[0]).toMatchObject({ invokedAt: 3_000 })
        expect(getMessageWindowState(id).messages[0].deliveryState).toBeUndefined()
    })

    it('marks queued rows consumed and reorders them by invoked position', () => {
        const id = sessionId('consumed')
        ingestIncomingMessages(id, [
            makeUserMessage({
                id: 'queued',
                seq: 1,
                localId: 'local-1',
                createdAt: 1_000,
                invokedAt: null,
                status: 'queued'
            }),
            makeAgentMessage({ id: 'agent', seq: 2, at: 2_000 })
        ])

        const beforeConsumed = getMessageWindowState(id).tailRevision
        markMessagesConsumed(id, ['local-1'], 3_000)

        expect(getMessageWindowState(id).messages.at(-1)).toMatchObject({
            id: 'queued',
            status: 'sent',
            invokedAt: 3_000
        })
        expect(getMessageWindowState(id).tailRevision).toBe(beforeConsumed + 1)
    })

    it('reconciles queued candidates without a secondary pending collection', () => {
        const id = sessionId('queued-reconcile')
        ingestIncomingMessages(id, [
            makeUserMessage({ id: 'stale', seq: 1, localId: 'local-stale', invokedAt: null }),
            makeUserMessage({ id: 'queued', seq: 2, localId: 'local-queued', invokedAt: null }),
            makeUserMessage({
                id: 'local-optimistic',
                localId: 'local-optimistic',
                invokedAt: null,
                status: 'sending'
            })
        ])
        updateMessageStatus(id, 'local-optimistic', 'queued')

        expect(new Set(getQueuedReconcileCandidateLocalIds(id))).toEqual(new Set([
            'local-stale',
            'local-queued',
            'local-optimistic'
        ]))
        reconcileQueuedLocalIds(
            id,
            ['local-stale', 'local-queued', 'local-optimistic'],
            ['local-queued']
        )

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['queued'])
    })

    it('removes a queued or optimistic row by localId idempotently', () => {
        const id = sessionId('remove')
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            invokedAt: null,
            status: 'queued'
        }))

        removeOptimisticMessage(id, 'local-1')
        removeOptimisticMessage(id, 'local-1')

        expect(getMessageWindowState(id).messages).toEqual([])
    })
})

describe('V2 persistence boundary', () => {
    it('ignores the V1 pending-buffer state entirely', () => {
        const id = sessionId('ignore-v1')
        sessionStorage.setItem(`hapi:message-window:v1:${id}`, JSON.stringify({
            messages: [makeAgentMessage({ id: 'legacy', seq: 1, at: 1 })],
            pending: []
        }))

        expect(getMessageWindowState(id).messages).toEqual([])
    })

    it('hydrates V2 sending rows as queued reconciliation candidates', () => {
        const id = sessionId('hydrate-sending')
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [makeUserMessage({
                id: 'local-1',
                localId: 'local-1',
                invokedAt: null,
                status: 'sending'
            })],
            hasMore: false,
            oldestPositionAt: null,
            oldestPositionSeq: null,
            newestPositionAt: null,
            newestPositionSeq: null,
            epoch: null
        }))

        expect(getMessageWindowState(id).messages[0]?.status).toBe('queued')
        expect(getQueuedReconcileCandidateLocalIds(id)).toEqual(['local-1'])
    })
})


describe('reasoning snapshot compaction', () => {
    it('keeps only the newest snapshot of each stream', () => {
        const id = sessionId('reasoning-compaction')
        const snapshots = Array.from({ length: 5 }, (_, index) =>
            makeReasoningMessage(`snap-${index}`, 'stream-1', index + 1, index + 1)
        )
        const others = [
            makeUserMessage({ id: 'user-1', seq: 10, invokedAt: 10, createdAt: 10 }),
            makeUserMessage({ id: 'user-2', seq: 11, invokedAt: 11, createdAt: 11 })
        ]
        ingestIncomingMessages(id, [...snapshots, ...others])

        expect(getMessageWindowState(id).messages.map((message) => message.id))
            .toEqual(['snap-4', 'user-1', 'user-2'])
    })

    it('keeps the newest snapshot of every stream independently', () => {
        const id = sessionId('reasoning-multi-stream')
        ingestIncomingMessages(id, [
            makeReasoningMessage('a-1', 'stream-a', 1, 1),
            makeReasoningMessage('a-2', 'stream-a', 2, 2),
            makeReasoningMessage('b-1', 'stream-b', 3, 3),
            makeReasoningMessage('b-2', 'stream-b', 4, 4)
        ])

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['a-2', 'b-2'])
    })

    it('leaves messages without a reasoning stream untouched', () => {
        const id = sessionId('reasoning-unrelated')
        const messages = [
            makeUserMessage({ id: 'user-1', seq: 1, invokedAt: 1, createdAt: 1 }),
            makeAgentRunMessage('run-1', 2, 2),
            makeAgentRunMessage('run-2', 3, 3)
        ]
        ingestIncomingMessages(id, messages)

        expect(getMessageWindowState(id).messages).toHaveLength(3)
    })

    it('spends the window budget on conversation rather than duplicate snapshots', () => {
        const id = sessionId('reasoning-window-budget')
        // A session already carrying a flood of stored snapshots: without
        // compaction they consume the whole window and the conversation that
        // surrounds them falls out of it.
        const flood = Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) =>
            makeReasoningMessage(`flood-${index}`, 'stream-1', index + 1, index + 1)
        )
        const conversation = Array.from({ length: 50 }, (_, index) =>
            makeUserMessage({
                id: `talk-${index}`,
                seq: VISIBLE_WINDOW_SIZE + index + 1,
                invokedAt: VISIBLE_WINDOW_SIZE + index + 1,
                createdAt: VISIBLE_WINDOW_SIZE + index + 1
            })
        )
        ingestIncomingMessages(id, [...flood, ...conversation])

        const kept = getMessageWindowState(id).messages
        for (const message of conversation) {
            expect(kept.some((candidate) => candidate.id === message.id)).toBe(true)
        }
        expect(kept.filter((message) => message.id.startsWith('flood-'))).toHaveLength(1)
    })

    // The seq bounds are a view over what the window currently holds; the
    // cursor that drives older-page requests is the server's own
    // `nextBefore*`, which compaction never touches. Pinning the bounds keeps
    // that distinction honest if the two are ever conflated.
    it('derives its seq bounds from the surviving rows', () => {
        const id = sessionId('reasoning-bounds')
        ingestIncomingMessages(id, [
            makeReasoningMessage('snap-1', 'stream-1', 1, 1),
            makeReasoningMessage('snap-2', 'stream-1', 2, 2),
            makeUserMessage({ id: 'user-1', seq: 3, invokedAt: 3, createdAt: 3 })
        ])

        const state = getMessageWindowState(id)
        expect(state.oldestSeq).toBe(2)
        expect(state.newestSeq).toBe(3)
    })
})
