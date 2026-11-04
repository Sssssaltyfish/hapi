import type { SessionSummary } from './types'

export type NativeVisibilityProject = {
    id: string
    name?: string
    memberCount: number
    nextCursor: string | null
    complete: boolean
}
export type NativeVisibilityState = {
    initialized: boolean
    threadIds: string[]
    hiddenThreadIds: string[]
    projects: NativeVisibilityProject[]
}
export type NativeVisibilityAction =
    | { action: 'track-thread'; threadId: string }
    | { action: 'hide-thread'; threadId: string }
    | { action: 'track-project'; projectId: string }
    | { action: 'hide-project'; projectId: string }
    | { action: 'discover-project'; projectId: string }
export type NativeVisibilityResponse = { visibility: NativeVisibilityState; sessions: SessionSummary[] }

/** Positive daemon provenance only: appServer/unknown can also be human chats. */
export function isNativeBackgroundThread(thread: Record<string, unknown>): boolean {
    const source = thread.source
    const sourceKind = typeof source === 'string' ? source
        : source && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source).join(' ') : ''
    return thread.ephemeral === true || Boolean(thread.parentThreadId || thread.parent_thread_id)
        || /^(exec|subagent)/i.test(sourceKind)
        || /exec|subagent/i.test(typeof thread.originator === 'string' ? thread.originator : '')
        || thread.threadSource === 'agent_created_thread' || thread.threadSource === 'ambient_suggestions'
}
export const NATIVE_ORDINARY_SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'unknown']
export const NATIVE_BACKGROUND_SOURCE_KINDS = ['exec', 'appServer', 'subAgent', 'subAgentReview',
    'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']
