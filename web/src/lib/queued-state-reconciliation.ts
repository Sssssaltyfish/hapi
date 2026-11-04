import type { ApiClient } from '@/api/client'
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

const QUEUED_STATE_BATCH_SIZE = 1000

export async function reconcileQueuedStateAfterConnect(
    api: ApiClient,
    sessionId: string,
    options?: { syncTail?: boolean }
): Promise<void> {
    if (options?.syncTail !== false) await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    const candidateLocalIds = getQueuedReconcileCandidateLocalIds(sessionId)
    if (candidateLocalIds.length === 0) {
        return
    }
    const queuedLocalIds: string[] = []
    const dispatchingLocalIds: string[] = []
    const rowsAtStart = new Map(getMessageWindowState(sessionId).messages.flatMap(row => row.localId ? [[row.localId, row] as const] : []))
    const indeterminateLocalIds: string[] = []
    const invokedLocalMessages: Array<{ localId: string; invokedAt: number }> = []
    for (let index = 0; index < candidateLocalIds.length; index += QUEUED_STATE_BATCH_SIZE) {
        const batch = candidateLocalIds.slice(index, index + QUEUED_STATE_BATCH_SIZE)
        const state = await api.getQueuedState(sessionId, batch)
        queuedLocalIds.push(...state.queuedLocalIds)
        dispatchingLocalIds.push(...(state.dispatchingLocalIds ?? []))
        indeterminateLocalIds.push(...(state.indeterminateLocalIds ?? []))
        invokedLocalMessages.push(...state.invokedLocalMessages)
    }
    const invokedByTimestamp = new Map<number, string[]>()
    for (const message of invokedLocalMessages) {
        const localIds = invokedByTimestamp.get(message.invokedAt) ?? []
        localIds.push(message.localId)
        invokedByTimestamp.set(message.invokedAt, localIds)
    }
    for (const [invokedAt, localIds] of invokedByTimestamp) {
        markMessagesConsumed(sessionId, localIds, invokedAt)
    }
    const currentRows = new Map(getMessageWindowState(sessionId).messages.flatMap(row => row.localId ? [[row.localId, row] as const] : []))
    const unchanged = (id: string) => rowsAtStart.has(id) && rowsAtStart.get(id) === currentRows.get(id)
    // Clear force-dismiss holds for rows that returned to ordinary FIFO while
    // SSE was down (#1839 queueDismissed).
    const queued = queuedLocalIds.filter(unchanged)
    const dispatching = dispatchingLocalIds.filter(unchanged)
    markMessagesRequeued(sessionId, [...new Set([...queued, ...dispatching])])
    markMessagesDispatching(sessionId, dispatching)
    markMessagesIndeterminate(sessionId, indeterminateLocalIds.filter(unchanged))
    reconcileQueuedLocalIds(sessionId, candidateLocalIds.filter(unchanged), [...new Set([...queuedLocalIds, ...dispatchingLocalIds, ...indeterminateLocalIds])])
}
