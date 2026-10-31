import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { markMessagesConsumed } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import { reconcileQueuedStateAfterConnect } from '@/lib/queued-state-reconciliation'

type SteerQueuedMessageInput = {
    sessionId: string
    messageId: string
}

/**
 * Mutation: request delivery of one queued message into the active agent turn.
 *
 * Non-optimistic on purpose: the CLI acknowledges the steer via the existing
 * `messages-consumed` event, which flips the row to invoked and removes it from
 * the floating bar. An optimistic removal here would fight that event and
 * would need a revert path for the failure case anyway.
 *
 * Failure surfaces as a toast; the row stays queued and can be retried.
 */
export function useSteerQueuedMessage(api: ApiClient | null) {
    const { t } = useTranslation()
    const { addToast } = useToast()

    const mutation = useMutation({
        mutationFn: async (input: SteerQueuedMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return api.steerMessage(input.sessionId, input.messageId)
        },
        onSuccess: async (result, input) => {
            if (result.status === 'pending') {
                // State comes from ordered SSE or queued-state reconciliation.
                // A late HTTP acknowledgement must not undo a newer requeue.
                if (api) await reconcileQueuedStateAfterConnect(api, input.sessionId, { syncTail: false }).catch(() => {})
                return
            }
            if (result.status === 'failed') {
                addToast({
                    title: t('queuedMessages.steerFailed'),
                    body: result.error ?? '',
                    sessionId: input.sessionId,
                    url: window.location.href,
                })
                return
            }
            if (result.status === 'invoked' && result.message.localId && typeof result.message.invokedAt === 'number') {
                // The CLI consumed this message before the steer arrived. If the
                // messages-consumed SSE was missed while the row was still
                // queued, reconcile it now so the queued bar cannot keep a
                // stale actionable row (mirrors useCancelQueuedMessage).
                markMessagesConsumed(input.sessionId, [result.message.localId], result.message.invokedAt)
            }
            // Accepted requests retain their row until messages-consumed arrives.
        },
        onError: (error, input) => {
            addToast({
                title: t('queuedMessages.steerFailed'),
                body: error instanceof Error ? error.message : '',
                sessionId: input.sessionId,
                url: window.location.href,
            })
        },
    })

    return mutation
}
