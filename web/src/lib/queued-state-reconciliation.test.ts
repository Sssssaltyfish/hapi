import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'

vi.mock('./message-window-store', () => ({
    getQueuedReconcileCandidateLocalIds: vi.fn(),
    getMessageWindowState: vi.fn(),
    markMessagesConsumed: vi.fn(),
    markMessagesDispatching: vi.fn(),
    markMessagesIndeterminate: vi.fn(),
    markMessagesRequeued: vi.fn(),
    reconcileQueuedLocalIds: vi.fn(),
    syncTailMessages: vi.fn(),
}))

import {
    getQueuedReconcileCandidateLocalIds,
    getMessageWindowState,
    markMessagesConsumed,
    markMessagesDispatching,
    markMessagesIndeterminate,
    markMessagesRequeued,
    reconcileQueuedLocalIds,
    syncTailMessages,
} from './message-window-store'
import { reconcileQueuedStateAfterConnect } from './queued-state-reconciliation'

const mockSyncTailMessages = vi.mocked(syncTailMessages)
const mockGetCandidates = vi.mocked(getQueuedReconcileCandidateLocalIds)
const mockGetWindow = vi.mocked(getMessageWindowState)
const mockMarkMessagesConsumed = vi.mocked(markMessagesConsumed)
const mockMarkMessagesIndeterminate = vi.mocked(markMessagesIndeterminate)
const mockMarkMessagesRequeued = vi.mocked(markMessagesRequeued)
const mockReconcileQueuedLocalIds = vi.mocked(reconcileQueuedLocalIds)

function setCandidates(ids: string[]) {
    mockGetCandidates.mockReturnValueOnce(ids)
    mockGetWindow.mockReturnValue({ messages: ids.map(localId => ({ localId, id: localId })) } as never)
}

function createMockApi(
    getQueuedState: ApiClient['getQueuedState'] = async () => ({
        queuedLocalIds: [],
        invokedLocalMessages: []
    })
): ApiClient {
    return { getQueuedState } as ApiClient
}

describe('reconcileQueuedStateAfterConnect', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockSyncTailMessages.mockResolvedValue(undefined)
        mockGetCandidates.mockReturnValue([])
        mockGetWindow.mockReturnValue({ messages: [] } as never)
        mockMarkMessagesIndeterminate.mockClear()
    })

    it('recovers missed pending and requeue events from explicit authoritative state groups', async () => {
        setCandidates(['pending', 'plain', 'unknown'])
        await reconcileQueuedStateAfterConnect(createMockApi(async () => ({
            queuedLocalIds: ['pending', 'plain'], dispatchingLocalIds: ['pending'],
            indeterminateLocalIds: ['unknown'], invokedLocalMessages: [],
        })), 'session-pending')
        expect(markMessagesDispatching).toHaveBeenCalledWith('session-pending', ['pending'])
        expect(mockMarkMessagesRequeued).toHaveBeenCalledWith('session-pending', ['pending', 'plain'])
        expect(mockMarkMessagesIndeterminate).toHaveBeenCalledWith('session-pending', ['unknown'])
    })

    it('refreshes pending delivery without fetching or moving message history', async () => {
        setCandidates(['pending'])
        await reconcileQueuedStateAfterConnect(createMockApi(async () => ({
            queuedLocalIds: ['pending'], dispatchingLocalIds: ['pending'], invokedLocalMessages: [],
        })), 'session-active', { syncTail: false })
        expect(mockSyncTailMessages).not.toHaveBeenCalled()
        expect(markMessagesDispatching).toHaveBeenCalledWith('session-active', ['pending'])
    })

    it('does not overwrite a newer SSE state with a stale queued-state response', async () => {
        setCandidates(['local-1'])
        let resolve!: (value: Awaited<ReturnType<ApiClient['getQueuedState']>>) => void
        const getQueuedState = vi.fn(() => new Promise<Awaited<ReturnType<ApiClient['getQueuedState']>>>(done => { resolve = done }))
        const running = reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-stale')
        await vi.waitFor(() => expect(getQueuedState).toHaveBeenCalled())
        mockGetWindow.mockReturnValue({ messages: [{ localId: 'local-1', id: 'local-1' }] } as never)
        resolve({ queuedLocalIds: ['local-1'], dispatchingLocalIds: ['local-1'], invokedLocalMessages: [] })
        await running
        expect(markMessagesDispatching).toHaveBeenCalledWith('session-stale', [])
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith('session-stale', [], ['local-1'])
    })

    it('waits for the latest messages before snapshotting and querying queued state', async () => {
        let resolveRefresh: (() => void) | undefined
        mockSyncTailMessages.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                resolveRefresh = resolve
            })
        )
        setCandidates(['local-1'])
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: ['local-1'],
            invokedLocalMessages: []
        }))

        const reconciliation = reconcileQueuedStateAfterConnect(
            createMockApi(getQueuedState),
            'session-A'
        )
        await Promise.resolve()

        expect(mockGetCandidates).not.toHaveBeenCalled()
        expect(getQueuedState).not.toHaveBeenCalled()

        resolveRefresh?.()
        await reconciliation

        expect(mockGetCandidates).toHaveBeenCalledWith('session-A')
        expect(mockSyncTailMessages).toHaveBeenCalledWith(
            expect.anything(),
            'session-A',
            { ensureAfterCurrent: true }
        )
        expect(getQueuedState).toHaveBeenCalledWith('session-A', ['local-1'])
    })

    it('passes the exact candidate snapshot to the endpoint and reconciliation', async () => {
        const candidateLocalIds = ['local-1', 'local-2']
        setCandidates(candidateLocalIds)
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: ['local-2'],
            invokedLocalMessages: []
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-B')

        expect(getQueuedState).toHaveBeenCalledWith('session-B', candidateLocalIds)
        expect(mockMarkMessagesRequeued).toHaveBeenCalledWith('session-B', ['local-2'])
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith(
            'session-B',
            candidateLocalIds,
            ['local-2'],
        )
    })

    it('applies authoritative invoked timestamps before reconciling absent rows', async () => {
        setCandidates(['local-1', 'local-2'])
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: ['local-2'],
            invokedLocalMessages: [{ localId: 'local-1', invokedAt: 1_000 }]
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-B')

        expect(mockMarkMessagesConsumed).toHaveBeenCalledWith('session-B', ['local-1'], 1_000)
        expect(mockMarkMessagesConsumed.mock.invocationCallOrder[0]).toBeLessThan(
            mockReconcileQueuedLocalIds.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
        )
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith(
            'session-B',
            ['local-1', 'local-2'],
            ['local-2'],
        )
    })

    it('chunks candidate IDs to stay within the endpoint limit', async () => {
        const candidateLocalIds = Array.from({ length: 1001 }, (_, index) => `local-${index}`)
        setCandidates(candidateLocalIds)
        const getQueuedState = vi.fn(async (_sessionId: string, localIds: string[]) => ({
            queuedLocalIds: localIds,
            invokedLocalMessages: []
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-E')

        expect(getQueuedState).toHaveBeenCalledTimes(2)
        expect(getQueuedState.mock.calls[0]?.[1]).toHaveLength(1000)
        expect(getQueuedState.mock.calls[1]?.[1]).toEqual(['local-1000'])
        expect(mockReconcileQueuedLocalIds).toHaveBeenCalledWith(
            'session-E',
            candidateLocalIds,
            candidateLocalIds,
        )
    })

    it('skips the endpoint and reconciliation when there are no candidates', async () => {
        const getQueuedState = vi.fn(async () => ({
            queuedLocalIds: [],
            invokedLocalMessages: []
        }))

        await reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-C')

        expect(getQueuedState).not.toHaveBeenCalled()
        expect(mockReconcileQueuedLocalIds).not.toHaveBeenCalled()
    })

    it('propagates endpoint failures without reconciling', async () => {
        const endpointError = new Error('queued state unavailable')
        setCandidates(['local-1'])
        const getQueuedState = vi.fn(async () => {
            throw endpointError
        })

        await expect(
            reconcileQueuedStateAfterConnect(createMockApi(getQueuedState), 'session-D')
        ).rejects.toBe(endpointError)
        expect(mockReconcileQueuedLocalIds).not.toHaveBeenCalled()
    })
})
