import type { ChatBlock, UserTextBlock } from '@/chat/types'
import { nativeQuestionReplyDisplayText } from '@/lib/nativeQuestionReply'

export type ConversationOutlineItem = {
    id: string
    targetMessageId: string
    kind: 'user'
    label: string
    createdAt: number
    historyPage?: ConversationHistoryPage
    /** Failed optimistic input is visible only in its current viewport. */
    transient?: boolean
}

export type ConversationHistoryPage =
    | { kind: 'native'; cursor: string | null }
    | { kind: 'runner'; beforeAt: number | null; beforeSeq: number | null; epoch: number | null }

export type ConversationOutlinePage = {
    items: ConversationOutlineItem[]
    next: ConversationHistoryPage | null
    scanned: number
    epoch: number | null
    reachedHead: boolean
    overlapId?: string
}

const MAX_OUTLINE_LABEL_LENGTH = 96

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function truncateOutlineLabel(value: string, maxLength = MAX_OUTLINE_LABEL_LENGTH): string {
    const normalized = collapseWhitespace(value)
    if (normalized.length <= maxLength) {
        return normalized
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function userBlockToOutlineItem(block: UserTextBlock): ConversationOutlineItem {
    const label = truncateOutlineLabel(nativeQuestionReplyDisplayText(block.text)) || 'Empty message'
    return {
        id: `outline:user-text:${block.id}`,
        targetMessageId: `user-text:${block.id}`,
        kind: 'user',
        label,
        createdAt: block.invokedAt ?? block.createdAt,
        ...(block.invokedAt === null && block.status === 'failed' ? { transient: true } : {}),
    }
}

function isLocatableOutlineBlock(block: ChatBlock): block is UserTextBlock {
    return block.kind === 'user-text'
        && !(block.invokedAt === null && block.status !== 'failed')
}

export function buildConversationOutline(blocks: readonly ChatBlock[]): ConversationOutlineItem[] {
    const items: ConversationOutlineItem[] = []

    for (const block of blocks) {
        if (isLocatableOutlineBlock(block)) {
            items.push(userBlockToOutlineItem(block))
        }
    }

    return items
}

export function getConversationMessageAnchorId(messageId: string): string {
    return `hapi-message-${messageId}`
}
