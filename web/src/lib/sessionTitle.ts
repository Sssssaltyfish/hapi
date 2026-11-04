import { parseCodexNativeSessionId } from '@/codex-native/session-key'

type SessionTitleSource = {
    id: string
    metadata?: {
        name?: string
        summary?: { text: string }
        path?: string
    } | null
}

/**
 * Distinguish explicit title metadata from path / ID display fallbacks.
 * Reference eligibility is based on conversation content, not this signal.
 */
export function hasSessionTitleSignal(session: SessionTitleSource): boolean {
    const meta = session.metadata
    if (!meta) return false
    if (meta.name?.trim()) return true
    if (meta.summary?.text?.trim()) return true
    return false
}

export function shortSessionId(id: string): string {
    return (parseCodexNativeSessionId(id)?.threadId ?? id).slice(0, 8)
}

export function getSessionTitle(session: SessionTitleSource): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        if (parts.length > 0) return parts[parts.length - 1]
    }
    return shortSessionId(session.id)
}
