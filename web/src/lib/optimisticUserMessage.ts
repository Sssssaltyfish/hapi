import type { MessageDeliveryMode } from '@hapi/protocol'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'

/** Browser-only preview; localId is also sent to the backend for reconciliation. */
export function optimisticUserMessage(input: {
    localId: string
    createdAt: number
    text: string
    deliveryMode: MessageDeliveryMode
    attachments?: AttachmentMetadata[]
    scheduledAt?: number | null
}): DecryptedMessage {
    return {
        id: input.localId,
        localId: input.localId,
        seq: null,
        createdAt: input.createdAt,
        invokedAt: null,
        scheduledAt: input.scheduledAt ?? null,
        content: {
            role: 'user',
            content: { type: 'text', text: input.text, attachments: input.attachments },
            meta: { deliveryMode: input.deliveryMode },
        },
        status: 'sending',
        originalText: input.text,
    }
}
