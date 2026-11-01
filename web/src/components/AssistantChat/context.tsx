import type { ReactNode } from 'react'
import { createContext, useContext, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import type { SessionMetadataSummary } from '@/types/api'
import { createWorkExpansionState } from './workExpansion'

export type OlderHistoryLoadResult = 'loaded' | 'transient-stop' | 'terminal-stop'

export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    /** Hub-wide AGENT_NOTIFY_SUMMARY chat display; polled once at chat shell. */
    showSessionSummaryInChat: boolean
    disabled: boolean
    onRefresh: () => void
    codexPlanProposalId?: string | null
    onContinuePlan?: (planId: string) => void
    continuedPlanIds?: ReadonlySet<string>
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onShareTurn?: (
        messageElement: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: { html: string; text: string; role?: 'user' | 'assistant' }
    ) => void
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
    onNestedScrollFollowChange?: (followLatest: boolean) => void
    loadOlderMessagesPreservingScroll: () => Promise<OlderHistoryLoadResult>
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

const MAX_TOOL_GROUP_EXPANSION_ENTRIES = 2048

function createToolGroupExpansionState() {
    let defaultOpen: boolean | undefined
    let revision = 0
    const entries = new Map<string, { open: boolean; revision: number }>()
    const resetForPreference = (nextDefault: boolean) => {
        if (defaultOpen === nextDefault) return
        defaultOpen = nextDefault
        entries.clear()
    }
    const remember = (toolIds: readonly string[], entry: { open: boolean; revision: number }) => {
        for (const id of toolIds) {
            entries.delete(id)
            entries.set(id, entry)
        }
        while (entries.size > MAX_TOOL_GROUP_EXPANSION_ENTRIES) {
            const oldest = entries.keys().next().value
            if (oldest === undefined) break
            entries.delete(oldest)
        }
    }
    return {
        get(toolIds: readonly string[], nextDefault: boolean): boolean {
            resetForPreference(nextDefault)
            let latest: { open: boolean; revision: number } | undefined
            for (const id of toolIds) {
                const entry = entries.get(id)
                if (entry && (!latest || entry.revision > latest.revision)) latest = entry
            }
            // Carry a manual choice across regrouping, even as old members leave the window.
            if (latest) remember(toolIds, latest)
            return latest?.open ?? nextDefault
        },
        set(toolIds: readonly string[], nextDefault: boolean, open: boolean) {
            resetForPreference(nextDefault)
            remember(toolIds, { open, revision: ++revision })
        }
    }
}

const ToolGroupExpansionContext = createContext<ReturnType<typeof createToolGroupExpansionState> | null>(null)
const WorkExpansionContext = createContext<ReturnType<typeof createWorkExpansionState> | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    // Cards can remount when history changes the surrounding assistant response.
    const toolGroupExpansion = useMemo(createToolGroupExpansionState, [props.value.sessionId])
    const workExpansion = useMemo(createWorkExpansionState, [props.value.sessionId])
    // Keep dismissal outside virtualized cards so recycling cannot revive a menu.
    const [continued, setContinued] = useState<{ sessionId: string; ids: ReadonlySet<string> }>({
        sessionId: props.value.sessionId, ids: new Set()
    })
    const ids = continued.sessionId === props.value.sessionId ? continued.ids : new Set<string>()
    const value: HappyChatContextValue = {
        ...props.value,
        continuedPlanIds: ids,
        onContinuePlan: props.value.onContinuePlan ? (planId) => {
            if (props.value.disabled || props.value.codexPlanProposalId !== planId || ids.has(planId)) return
            setContinued({ sessionId: props.value.sessionId, ids: new Set([...ids, planId]) })
            props.value.onContinuePlan?.(planId)
        } : undefined
    }
    return (
        <HappyChatContext.Provider value={value}>
            <ToolGroupExpansionContext.Provider value={toolGroupExpansion}>
                <WorkExpansionContext.Provider value={workExpansion}>{props.children}</WorkExpansionContext.Provider>
            </ToolGroupExpansionContext.Provider>
        </HappyChatContext.Provider>
    )
}

export function useToolGroupExpansionState() {
    const state = useContext(ToolGroupExpansionContext)
    if (!state) throw new Error('HappyChatContext is missing')
    return state
}

export function useOptionalWorkExpansionState() {
    return useContext(WorkExpansionContext)
}

export function useOptionalHappyChatContext(): HappyChatContextValue | null {
    return useContext(HappyChatContext)
}

export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useOptionalHappyChatContext()
    if (!ctx) {
        throw new Error('HappyChatContext is missing')
    }
    return ctx
}
