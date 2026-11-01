import type { ConversationScrollAnchor } from './conversation-scroll-anchor'

export type ConversationReadingPosition = {
    anchor: ConversationScrollAnchor | null
    scrollTop: number
    atBottom: boolean
    savedAt: number
}

// Navigation state only: transcript content stays in its existing bounded window.
const positions = new Map<string, ConversationReadingPosition>()
const MAX_SESSIONS = 40
const MAX_AGE_MS = 2 * 60 * 60 * 1000

export function getConversationReadingPosition(id: string): ConversationReadingPosition | null {
    const position = positions.get(id)
    if (position && Date.now() - position.savedAt <= MAX_AGE_MS) return position
    positions.delete(id)
    return null
}

export function saveConversationReadingPosition(id: string, position: Omit<ConversationReadingPosition, 'savedAt'>): void {
    positions.delete(id)
    positions.set(id, { ...position, savedAt: Date.now() })
    while (positions.size > MAX_SESSIONS) positions.delete(positions.keys().next().value!)
}

export function clearConversationReadingPosition(id: string): void {
    positions.delete(id)
}
