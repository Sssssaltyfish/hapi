import type { VisibleChatBlock } from '@/chat/toolGroups'
import { getToolGroupEntries, visibleBlockRole } from '@/chat/toolGroups'

function metadata(block: VisibleChatBlock): Record<string, unknown> {
    const entry = block.kind === 'tool-group' ? getToolGroupEntries(block)[0] : block
    return entry?.meta && typeof entry.meta === 'object' ? entry.meta as Record<string, unknown> : {}
}

/** Keep provider response boundaries without making visibility depend on history coverage. */
export function getNativeResponseGroupingKey(block: VisibleChatBlock): string | undefined {
    if (visibleBlockRole(block) !== 'assistant') return undefined
    const meta = metadata(block)
    if (meta.nativeCodexRecord !== true || typeof meta.codexTurnId !== 'string') return undefined
    if (block.kind === 'agent-text') {
        if (meta.nativeCodexMessagePhase === 'final_answer') return `codex:${meta.codexTurnId}:final`
        if (meta.nativeCodexMessagePhase !== 'commentary') return `codex:${meta.codexTurnId}:unclassified:${block.id}`
    }
    return `codex:${meta.codexTurnId}:commentary`
}
