import type { VisibleChatBlock } from '@/chat/toolGroups'
import { visibleBlockRole } from '@/chat/toolGroups'

export type WorkGroup = { turnId: string; canCollapse: boolean; finalKnown: boolean; blocked: boolean; active: boolean }

function metadata(block: VisibleChatBlock): Record<string, unknown> {
    if (block.kind === 'tool-group') return metadata(block.tools[0])
    return block.meta && typeof block.meta === 'object' ? block.meta as Record<string, unknown> : {}
}

export function getWorkTurnId(block: VisibleChatBlock): string | undefined {
    const value = metadata(block).codexTurnId
    return typeof value === 'string' ? value : undefined
}

export function isExplicitFinalAnswer(block: VisibleChatBlock): boolean {
    return block.kind === 'agent-text' && metadata(block).nativeCodexMessagePhase === 'final_answer'
}

function hasPendingInteraction(block: VisibleChatBlock): boolean {
    if (block.kind === 'tool-group') return block.tools.some(hasPendingInteraction)
    if (block.kind !== 'tool-call') return false
    return block.tool.permission?.status === 'pending' || block.children.some(hasPendingInteraction)
}

/** Only provider phase and authoritative turn state can identify completed work. */
export function getWorkGroups(blocks: readonly VisibleChatBlock[]): Map<string, WorkGroup> {
    const groups = new Map<string, WorkGroup>()
    const finals = new Set(blocks.flatMap(block => {
        const turnId = getWorkTurnId(block)
        return turnId && isExplicitFinalAnswer(block) && metadata(block).nativeCodexItemComplete === true ? [turnId] : []
    }))
    for (const block of blocks) {
        const turnId = getWorkTurnId(block)
        if (!turnId || visibleBlockRole(block) === 'user') continue
        const previous = groups.get(turnId)
        const blocked = metadata(block).nativeCodexTurnState !== 'inactive' || hasPendingInteraction(block) || previous?.blocked === true
        groups.set(turnId, { turnId, finalKnown: finals.has(turnId), blocked, active: metadata(block).nativeCodexTurnState === 'active' || previous?.active === true, canCollapse: finals.has(turnId) && !blocked })
    }
    return groups
}

export function getWorkGroupingKey(block: VisibleChatBlock): string | undefined {
    if (visibleBlockRole(block) === 'user') return undefined
    if (metadata(block).nativeCodexRecord !== true) return undefined
    const turnId = getWorkTurnId(block)
    if (!turnId) return undefined
    // Unknown phase is visible on its own until the provider classifies it.
    // It must never be hidden as work or mistaken for a final answer.
    if (block.kind === 'agent-text' && metadata(block).nativeCodexMessagePhase !== 'commentary' && !isExplicitFinalAnswer(block)) {
        return `codex:${turnId}:unclassified:${block.id}`
    }
    return `codex:${turnId}:${isExplicitFinalAnswer(block) ? 'final' : 'work'}`
}
