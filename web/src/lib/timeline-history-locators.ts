import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import type { TimelineHistoryLocator } from './stable-chat-timeline'

/** Attach source positions before the reducer folds calls, results and text. */
export function buildTimelineHistoryLocators(
    messages: readonly DecryptedMessage[],
    normalized: readonly NormalizedMessage[],
    native?: ReadonlyMap<string, TimelineHistoryLocator>,
    epoch?: number | null,
): ReadonlyMap<string, TimelineHistoryLocator> {
    const result = new Map<string, TimelineHistoryLocator>(native)
    for (const message of messages) {
        if (native || message.seq === null || message.seq === undefined || message.invokedAt === null) continue
        result.set(message.id, {
            kind: 'runner',
            beforeAt: message.invokedAt ?? message.createdAt,
            beforeSeq: message.seq + 1,
            ...(epoch != null ? { epoch } : {}),
            targetMessageId: message.id,
        })
    }
    for (const message of normalized) {
        const locator = result.get(message.id)
        if (!locator) continue
        if (message.localId) result.set(message.localId, locator)
        if (message.role !== 'agent') continue
        for (const content of message.content) {
            // Prefer a call's position to the later result; both belong to the
            // same rendered tool and the context fetch reads in both directions.
            if (content.type === 'tool-call') result.set(content.id, locator)
            if (content.type === 'tool-result' && !result.has(content.tool_use_id)) result.set(content.tool_use_id, locator)
            if ('uuid' in content && content.uuid) result.set(content.uuid, locator)
            if ('streamId' in content && content.streamId) result.set(content.streamId, locator)
        }
    }
    return result
}
