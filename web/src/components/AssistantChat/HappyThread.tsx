import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ThreadPrimitive, unstable_useThreadMessageIds, useAuiState } from '@assistant-ui/react'
import type { ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { HappyRuntimeExtras } from '@/lib/assistant-runtime'
import type { Session, SessionMetadataSummary } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { formatMessageTimestampTitle, formatOutlineTimestamp } from '@/chat/presentation'
import {
    HappyChatProvider,
    type OlderHistoryLoadResult
} from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useTranslation } from '@/lib/use-translation'
import { CloseIcon } from '@/components/icons'
import { ShareTurnDialog } from '@/components/AssistantChat/ShareTurnDialog'
import { SelectedTextQuote } from '@/components/AssistantChat/SelectedTextQuote'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { getSessionTitle } from '@/lib/sessionTitle'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { resolveSessionHeaderMachineLabel } from '@/components/SessionHeader'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatSessionHeaderTimestamp } from '@/lib/sessionHeaderTimestamp'
import { getShareTurnReasoningLabel, selectShareTurnMetadata } from '@/lib/shareTurnMetadata'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { useTransientScrollbar } from '@/hooks/useTransientScrollbar'
import { queryKeys } from '@/lib/query-keys'
import { matchesSearchQuery } from '@hapi/protocol'
import { getConversationReadingPosition, saveConversationReadingPosition } from '@/lib/conversation-reading-position'
import { revealConversationMessage } from '@/lib/revealConversationMessage'
import { HistoryScrollPrefetch } from '@/lib/history-page-cache'
import {
    captureConversationScrollAnchor as captureScrollAnchor,
    restoreConversationScrollAnchor as restoreScrollAnchor,
    type ConversationScrollAnchor as ScrollAnchor
} from '@/lib/conversation-scroll-anchor'

export { captureScrollAnchor, restoreScrollAnchor }

type PendingScrollRestore = {
    runId: number
    anchor: ScrollAnchor | null
    scrollTop: number
    scrollHeight: number
    targetHistoryVersion: number | null
    direction?: 'older' | 'newer'
}

type HistoryLoadSource = 'coverage' | 'user' | 'consumer'

type HistoryLoaderState = {
    runId: number
    phase: 'idle' | 'loading' | 'backoff' | 'awaiting-render'
    source: HistoryLoadSource | null
    failureCount: number
    autoPaused: boolean
    direction?: 'older' | 'newer'
}

type ShareTurnState = {
    id: number
    snapshots: ShareTurnSnapshot[]
    sourceContentWidth: number | null
} | null

type ShareTurnSnapshot = {
    html: string
    text: string
    role?: 'user' | 'assistant'
}

export function isNestedScrollEvent(event: Event): boolean {
    const target = event.target
    const element = typeof Element !== 'undefined' && target instanceof Element
        ? target
        : typeof Node !== 'undefined' && target instanceof Node
            ? target.parentElement
            : null
    return element?.closest('[data-hapi-nested-scroll="true"]') != null
}

function findNearestMessageElement(content: HTMLElement, clientY?: number): HTMLElement | null {
    const messages = Array.from(content.querySelectorAll('.happy-thread-messages > [id]'))
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
    if (messages.length === 0) return null
    if (typeof clientY !== 'number' || !Number.isFinite(clientY)) {
        return messages[messages.length - 1] ?? null
    }

    let best: HTMLElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const message of messages) {
        const rect = message.getBoundingClientRect()
        const distance = clientY < rect.top
            ? rect.top - clientY
            : clientY > rect.bottom
                ? clientY - rect.bottom
                : 0
        if (distance < bestDistance) {
            best = message
            bestDistance = distance
        }
    }
    return best
}

export function prependMissingUserSnapshot(
    snapshots: ShareTurnSnapshot[],
    fallbackSnapshot?: ShareTurnSnapshot
): ShareTurnSnapshot[] {
    const hasUser = snapshots.some((snapshot) =>
        snapshot.role === 'user' || snapshot.html.includes('data-hapi-message-role="user"')
    )
    if (hasUser || fallbackSnapshot?.role !== 'user' || fallbackSnapshot.text.trim().length === 0) {
        return snapshots
    }
    return [fallbackSnapshot, ...snapshots]
}

// Resume tail-following only once the user has actually reached the bottom.
// A wider proximity threshold makes a downward-reading user enter tail mode
// early; the next content/layout update then snaps the viewport to the end.
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1
const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'
const MANUAL_SCROLL_EPSILON_PX = 1
const INITIAL_SCROLL_SETTLE_MS = 1800
const INITIAL_SCROLL_SETTLE_DELAYS_MS = [0, 16, 50, 120, 250, 500, 900, 1400, 1800] as const
const HISTORY_PRELOAD_MARGIN_PX = 200
// Bounded backoff for the same logical history load. A failed page leaves the
// viewport geometry unchanged, so no new scroll/resize signal is guaranteed.
const COVERAGE_FAILURE_RETRY_DELAY_MS = 1000
const MAX_COVERAGE_LOAD_RETRIES = 3
// Silence between wheel events that marks the end of one upward gesture.
// Trackpads emit a burst per swipe; one signal is enough to restart a paused
// run after its bounded retry budget is exhausted.
const WHEEL_GESTURE_GAP_MS = 250
const POINTER_CANCEL_INTENT_WINDOW_MS = 750
const UPWARD_SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

type ScrollIntent = {
    distanceFromBottom: number
    isNearBottom: boolean
    isScrollingUp: boolean
    isScrollingDown: boolean
}

export function getScrollIntent(params: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    previousScrollTop: number
    thresholdPx?: number
}): ScrollIntent {
    const thresholdPx = params.thresholdPx ?? AUTO_SCROLL_RESUME_THRESHOLD_PX
    const distanceFromBottom = params.scrollHeight - params.scrollTop - params.clientHeight
    return {
        distanceFromBottom,
        isNearBottom: distanceFromBottom <= thresholdPx,
        isScrollingUp: params.scrollTop < params.previousScrollTop - MANUAL_SCROLL_EPSILON_PX,
        isScrollingDown: params.scrollTop > params.previousScrollTop + MANUAL_SCROLL_EPSILON_PX
    }
}

export function shouldShowScrollToBottomButton(intent: ScrollIntent): boolean {
    return !intent.isNearBottom
}

export function getScrollToBottomButtonVisibility(
    _wasVisible: boolean,
    intent: ScrollIntent
): boolean {
    return !intent.isNearBottom
}

export function shouldRenderScrollToBottomButton(
    isVisible: boolean,
    unseenCount: number
): boolean {
    return isVisible && unseenCount === 0
}

export function shouldCancelInitialScrollSettling(
    intent: ScrollIntent,
    hasExplicitUpwardIntent: boolean
): boolean {
    return hasExplicitUpwardIntent
        && intent.isScrollingUp
        && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX
}

export function hasAppliedHistoryVersion(
    pendingHistoryVersion: number,
    appliedHistoryVersion: number
): boolean {
    return appliedHistoryVersion > pendingHistoryVersion
}

export function shouldLoadOlderForViewport(params: {
    scrollHeight: number
    clientHeight: number
    viewportTop: number
    sentinelTop: number
    sentinelBottom: number
    preloadMarginPx?: number
}): boolean {
    const preloadMarginPx = params.preloadMarginPx ?? HISTORY_PRELOAD_MARGIN_PX
    if (params.scrollHeight <= params.clientHeight + 1) {
        return true
    }
    return params.sentinelBottom >= params.viewportTop - preloadMarginPx
        && params.sentinelTop <= params.viewportTop + preloadMarginPx
}

export function getHistoryCoverageRetryDelay(deadline: number, now: number): number {
    return Math.max(0, deadline - now) + 16
}

const SCROLL_TO_BOTTOM_BUTTON_CLASS = 'absolute bottom-0 right-2 z-10 h-6 w-6 rounded-full border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-0 text-[var(--app-fg)] hover:bg-[var(--app-bg)]'

function ScrollToBottomButton(props: { onClick: () => void; count?: number }) {
    const { t } = useTranslation()
    const hasCount = typeof props.count === 'number'
    const label = hasCount
        ? `${t('misc.newMessage', { n: props.count! })} — ${t('misc.scrollToBottom')}`
        : t('misc.scrollToBottom')
    const buttonClass = hasCount
        ? 'absolute bottom-0 right-2 z-10 h-6 w-6 rounded-full border-[var(--app-button)] bg-[var(--app-button)] px-0 text-[var(--app-button-text)] hover:opacity-90'
        : SCROLL_TO_BOTTOM_BUTTON_CLASS

    return (
        <Button
            variant="outline"
            type="button"
            onClick={props.onClick}
            aria-label={label}
            title={label}
            className={buttonClass}
        >
            {hasCount ? (
                <span className="translate-y-px text-[10px] font-semibold leading-none tabular-nums" aria-hidden="true">
                    {props.count! > 99 ? '99+' : props.count}
                </span>
            ) : (
                <svg
                    className="h-4 w-4 translate-y-px"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="m6 9 6 6 6-6" />
                </svg>
            )}
        </Button>
    )
}

function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    if (props.count === 0) {
        return null
    }
    return <ScrollToBottomButton count={props.count} onClick={props.onClick} />
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{t('misc.loadingMessages')}</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

type ThreadMessageComponents = ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']

/**
 * Render messages by stable id instead of their current array index.
 *
 * Rewind can replace a non-empty transcript with an empty one in a single
 * external-runtime update. Index-based providers may then ask assistant-ui
 * for message 0 while its lookup table is already empty. Stable id providers
 * unmount removed rows without consulting a stale index.
 */
export function ThreadMessagesById({ components }: { components: ThreadMessageComponents }) {
    const messageIds = unstable_useThreadMessageIds()

    return (
        <>
            {messageIds.map((messageId) => (
                <ThreadPrimitive.Unstable_MessageById
                    key={messageId}
                    messageId={messageId}
                    components={components}
                />
            ))}
        </>
    )
}

export function ConversationOutlinePanel(props: {
    items: readonly ConversationOutlineItem[]
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => void
    onSelect: (item: ConversationOutlineItem) => void
    onClose: () => void
    error?: string | null
    capped?: boolean
    scannedPages?: number
}) {
    const { t, locale } = useTranslation()
    const [searchQuery, setSearchQuery] = useState('')
    const normalizedSearchQuery = searchQuery.trim()
    const filteredItems = useMemo(() => {
        if (normalizedSearchQuery.length === 0) {
            return props.items
        }
        return props.items.filter((item) => (
            matchesSearchQuery(item.label, normalizedSearchQuery)
        ))
    }, [normalizedSearchQuery, props.items])

    return (
        <aside
            className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[24rem] flex-col bg-[var(--app-bg)] shadow-2xl sm:w-[24rem]"
            aria-label={t('session.outline.title')}
        >
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -left-px w-px bg-[var(--app-border)]" />
            <div className="border-b border-[var(--app-border)] p-3">
                <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
                            aria-hidden="true"
                        >
                            <circle cx="11" cy="11" r="8" />
                            <path d="m21 21-4.3-4.3" />
                        </svg>
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder={t('session.outline.searchPlaceholder')}
                            aria-label={t('session.outline.searchLabel')}
                            className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-9 pr-3 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] focus:ring-1 focus:ring-[var(--app-link)]"
                        />
                    </div>
                    {props.hasMoreMessages || props.isLoadingMoreMessages ? (
                        <Button
                            variant="outline"
                            onClick={props.onLoadMore}
                            disabled={props.isLoadingMoreMessages}
                            aria-busy={props.isLoadingMoreMessages}
                            aria-label={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            title={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            className="h-9 w-9 shrink-0 px-0"
                        >
                            {props.isLoadingMoreMessages ? (
                                <Spinner size="sm" label={null} className="text-current" />
                            ) : (
                                <span className="text-base leading-none" aria-hidden="true">↑</span>
                            )}
                        </Button>
                    ) : null}
                    <Button
                        variant="outline"
                        type="button"
                        onClick={props.onClose}
                        aria-label={t('button.close')}
                        title={t('button.close')}
                        className="h-9 w-9 shrink-0 px-0"
                    >
                        <CloseIcon className="h-4 w-4" />
                    </Button>
                </div>
                {normalizedSearchQuery.length > 0 ? (
                    <div className="mt-1.5 text-right text-xs text-[var(--app-hint)]" aria-live="polite">
                        {t('session.outline.searchResults', {
                            matched: filteredItems.length,
                            total: props.items.length
                        })}
                    </div>
                ) : null}
            </div>

            <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-hint)]" role="status">
                <div>{t(props.isLoadingMoreMessages ? 'session.outline.completing' : 'session.outline.indexedPrompts', { n: props.items.length })}</div>
                {props.error || t(props.capped ? 'session.outline.indexLimit' : props.hasMoreMessages ? 'session.outline.partialIndex' : 'session.outline.indexComplete')}
            </div>
            <div className="app-scroll-y min-h-0 flex-1 p-2">
                {props.items.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.empty')}
                    </div>
                ) : filteredItems.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.noSearchResults')}
                    </div>
                ) : (
                    <div className="space-y-1">
                        {filteredItems.map((item) => {
                            const createdAt = new Date(item.createdAt)
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => props.onSelect(item)}
                                    className="group block w-full min-w-0 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <span className="flex min-w-0 items-center gap-2 text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-button)]" aria-hidden="true" />
                                        <time
                                            dateTime={createdAt.toISOString()}
                                            title={formatMessageTimestampTitle(createdAt)}
                                            className="truncate"
                                        >
                                            {formatOutlineTimestamp(createdAt, locale)}
                                        </time>
                                    </span>
                                    <span className="mt-0.5 line-clamp-2 pl-4 text-sm leading-snug text-[var(--app-fg)]">
                                        {item.label}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </aside>
    )
}

export function HappyThread(props: {
    api: ApiClient
    session: Session
    serviceTier?: string | null
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onContinuePlan?: () => void
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onViewModeChange: (mode: 'tail' | 'history') => void
    isSyncingTail: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    hasNewerMessages?: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onLoadNewer?: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onPrefetchHistory?: (direction: 'older' | 'newer', pages?: number) => Promise<void>
    onCancelLoadMore: () => void
    unseenCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    historyVersion: number
    forceScrollToken: number
    outlineOpen: boolean
    outlineItems: readonly ConversationOutlineItem[]
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
    outlineHasEarlier?: boolean
    outlineLoading?: boolean
    outlineError?: string | null
    outlineCapped?: boolean
    outlineScannedPages?: number
    onLoadEarlierOutline?: () => Promise<void>
    onLocateOutlineItem?: (item: ConversationOutlineItem, isCurrent?: () => boolean) => Promise<boolean>
}) {
    const { t, locale } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const { machines } = useMachines(props.api, true)
    const machineLabelsById = useMachineLabels(machines, [props.session])
    const [shareTurn, setShareTurn] = useState<ShareTurnState>(null)
    const shareDialogOpen = shareTurn !== null
    const shareTitle = shareTurn ? getSessionTitle(props.session) : ''
    const shareRelativeTimeTick = useMinuteTick(headerMetadata.lastActive && shareDialogOpen)
    const shareMetadataItems = useMemo(() => {
        const agentFlavor = props.session.metadata?.flavor ?? null
        const agentLabel = agentFlavor?.trim() || null
        const machineLabel = resolveSessionHeaderMachineLabel(props.session, machineLabelsById)
        const modelLabel = getSessionModelLabel(props.session)
        const reasoningLabel = getShareTurnReasoningLabel(
            agentFlavor,
            props.session.modelReasoningEffort,
            props.session.effort,
            headerMetadata.showLabels
        )
        const lastActiveAt = props.session.activeAt || props.session.updatedAt || props.session.createdAt
        const lastActiveLabel = lastActiveAt > 0 ? formatRelativeTime(lastActiveAt, t) : null
        const createdAtLabel = formatSessionHeaderTimestamp(props.session.createdAt, locale)
        const updatedAtLabel = formatSessionHeaderTimestamp(props.session.updatedAt, locale)
        const worktreeBranch = props.session.metadata?.worktree?.branch?.trim() || null
        const showFastBadge = agentFlavor === 'codex'
            && isFastServiceTier(props.serviceTier ?? props.session.serviceTier)

        return selectShareTurnMetadata(headerMetadata, {
            agent: agentLabel ? { text: agentLabel, flavor: agentFlavor } : undefined,
            machine: machineLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.machine')}: ` : ''}${machineLabel}`,
            } : undefined,
            lastActive: lastActiveLabel ? { text: lastActiveLabel } : undefined,
            model: modelLabel ? {
                text: `${headerMetadata.showLabels ? `${t(modelLabel.key)}: ` : ''}${modelLabel.value}`,
            } : undefined,
            reasoning: reasoningLabel ? { text: reasoningLabel } : undefined,
            fastMode: showFastBadge ? { text: 'fast' } : undefined,
            createdAt: createdAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.createdAt')}: ` : ''}${createdAtLabel}`,
            } : undefined,
            updatedAt: updatedAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.updatedAt')}: ` : ''}${updatedAtLabel}`,
            } : undefined,
            worktree: worktreeBranch ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.worktree')}: ` : ''}${worktreeBranch}`,
            } : undefined,
        })
    }, [headerMetadata, locale, machineLabelsById, props.serviceTier, props.session, shareDialogOpen, shareRelativeTimeTick, t])
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const hubSettingsQuery = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => props.api.getHubSettings(),
        enabled: Boolean(props.api),
        staleTime: 30_000,
        refetchInterval: 30_000,
        retry: false,
    })
    const showSessionSummaryInChat = hubSettingsQuery.data?.sessionSummaryInChat === true
    const runtimeExtras = useAuiState((s) => s.thread.extras) as HappyRuntimeExtras | undefined
    const appliedMessagesVersion = runtimeExtras?.messagesVersion ?? props.messagesVersion
    const appliedHistoryVersion = runtimeExtras?.historyVersion ?? props.historyVersion
    const viewportRef = useRef<HTMLDivElement | null>(null)
    useTransientScrollbar(viewportRef, 'right')
    const contentRef = useRef<HTMLDivElement | null>(null)
    const [showScrollToBottom, setShowScrollToBottom] = useState(false)
    const [historyLoading, setHistoryLoading] = useState(false)
    const [outlineNavigating, setOutlineNavigating] = useState(false)
    const [outlineNavigationError, setOutlineNavigationError] = useState<string | null>(null)
    const shareTurnIdRef = useRef(0)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const pendingScrollRef = useRef<PendingScrollRestore | null>(null)
    const layoutAnchorRef = useRef<ScrollAnchor | null>(null)
    const historyDirectionRef = useRef<'older' | 'newer'>('older')
    const noProgressPagesRef = useRef(0)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const isSyncingTailRef = useRef(props.isSyncingTail)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onLoadNewerRef = useRef(props.onLoadNewer)
    onLoadNewerRef.current = props.onLoadNewer
    const prefetchHistoryRef = useRef(props.onPrefetchHistory)
    prefetchHistoryRef.current = props.onPrefetchHistory
    const scrollPrefetchRef = useRef(new HistoryScrollPrefetch())
    const onCancelLoadMoreRef = useRef(props.onCancelLoadMore)
    const pendingLoadPromiseRef = useRef<Promise<OlderHistoryLoadResult> | null>(null)
    const pendingLoadResolveRef = useRef<((value: OlderHistoryLoadResult) => void) | null>(null)
    const coverageCheckTimerRef = useRef<number | null>(null)
    const failureRetryTimerRef = useRef<number | null>(null)
    const tailScrollInProgressRef = useRef(false)
    const historyLoaderRef = useRef<HistoryLoaderState>({
        runId: 0,
        phase: 'idle',
        source: null,
        failureCount: 0,
        autoPaused: false
    })

    useLayoutEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const updateScrollbarGutter = () => {
            const supportsStableBothEdges = typeof CSS !== 'undefined'
                && typeof CSS.supports === 'function'
                && CSS.supports('scrollbar-gutter: stable both-edges')
            const gutter = supportsStableBothEdges
                ? Math.max(0, (viewport.offsetWidth - viewport.clientWidth) / 2)
                : 0
            viewport.style.setProperty('--chat-scroll-gutter-inline', `${gutter}px`)
        }

        updateScrollbarGutter()
        if (typeof ResizeObserver === 'undefined') return

        const observer = new ResizeObserver(updateScrollbarGutter)
        observer.observe(viewport)
        return () => observer.disconnect()
    }, [])
    const requestOlderRef = useRef<(source: HistoryLoadSource) => Promise<OlderHistoryLoadResult>>(
        () => Promise.resolve('transient-stop')
    )
    const requestNewerRef = useRef<(source: HistoryLoadSource) => Promise<OlderHistoryLoadResult>>(() => Promise.resolve('transient-stop'))
    const startHistoryLoadAttemptRef = useRef<(runId: number) => void>(() => {})
    const needsViewportCoverageRef = useRef<() => boolean>(() => false)
    const needsNewerCoverageRef = useRef<() => boolean>(() => false)
    const atBottomRef = useRef(true)
    const onViewModeChangeRef = useRef(props.onViewModeChange)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const lastScrollTopRef = useRef(0)
    const sessionIdRef = useRef(props.sessionId)
    const initialScrollSessionRef = useRef<string | null>(null)
    const initialScrollDeadlineRef = useRef(0)
    const initialScrollTimersRef = useRef<number[]>([])
    const pendingReadingPositionRef = useRef(getConversationReadingPosition(props.sessionId))
    const outlineNavigationRef = useRef(0)
    const outlineSeekPendingRef = useRef(false)
    const closingOutlineNavigationRef = useRef<number | null>(null)
    const outlineOpenRef = useRef(props.outlineOpen)
    outlineOpenRef.current = props.outlineOpen
    const hasNewerMessagesRef = useRef(Boolean(props.hasNewerMessages))
    hasNewerMessagesRef.current = Boolean(props.hasNewerMessages)

    // Smart scroll state: enabled only while the user is intentionally at the bottom.
    const autoScrollEnabledRef = useRef(true)
    useEffect(() => {
        onViewModeChangeRef.current = props.onViewModeChange
    }, [props.onViewModeChange])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useEffect(() => {
        isSyncingTailRef.current = props.isSyncingTail
    }, [props.isSyncingTail])
    useLayoutEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])
    useEffect(() => {
        onCancelLoadMoreRef.current = props.onCancelLoadMore
    }, [props.onCancelLoadMore])

    useEffect(() => {
        sessionIdRef.current = props.sessionId
    }, [props.sessionId])

    const isInitialScrollSettling = useCallback(() => {
        return initialScrollSessionRef.current === sessionIdRef.current && Date.now() < initialScrollDeadlineRef.current
    }, [])

    const clearInitialScrollTimers = useCallback(() => {
        for (const timer of initialScrollTimersRef.current) {
            window.clearTimeout(timer)
        }
        initialScrollTimersRef.current = []
    }, [])

    const clearCoverageCheckTimer = useCallback(() => {
        if (coverageCheckTimerRef.current !== null) {
            window.clearTimeout(coverageCheckTimerRef.current)
            coverageCheckTimerRef.current = null
        }
    }, [])

    const clearFailureRetryTimer = useCallback(() => {
        if (failureRetryTimerRef.current !== null) {
            window.clearTimeout(failureRetryTimerRef.current)
            failureRetryTimerRef.current = null
        }
    }, [])

    const settlePendingLoad = useCallback((result: OlderHistoryLoadResult) => {
        setHistoryLoading(false)
        const resolve = pendingLoadResolveRef.current
        pendingLoadResolveRef.current = null
        pendingLoadPromiseRef.current = null
        resolve?.(result)
    }, [])

    const cancelActiveHistoryLoad = useCallback(() => {
        const state = historyLoaderRef.current
        // `awaiting-render` is pre-armed by onBeforeApply and published with an
        // immediate store notification, so browser input cannot observe the
        // old DOM after trimming. Only network/backoff work is cancellable.
        if (
            state.source === 'consumer'
            || (state.phase !== 'loading' && state.phase !== 'backoff')
        ) {
            return
        }
        onCancelLoadMoreRef.current()
        isLoadingMoreRef.current = false
        pendingScrollRef.current = null
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        historyLoaderRef.current = {
            ...state,
            runId: state.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: false
        }
        settlePendingLoad('transient-stop')
    }, [clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    const stopHistoryForNavigation = useCallback(() => {
        layoutAnchorRef.current = null
        onCancelLoadMoreRef.current()
        pendingScrollRef.current = null
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        historyLoaderRef.current = { runId: historyLoaderRef.current.runId + 1, phase: 'idle', source: null, failureCount: 0, autoPaused: true }
        settlePendingLoad('transient-stop')
    }, [clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        lastScrollTopRef.current = viewport.scrollTop

        const setAutoScrollMode = (enabled: boolean) => {
            if (autoScrollEnabledRef.current === enabled) {
                return
            }
            autoScrollEnabledRef.current = enabled
        }

        const setAtBottomMode = (atBottom: boolean) => {
            if (atBottom === atBottomRef.current) {
                return
            }
            atBottomRef.current = atBottom
            onViewModeChangeRef.current(atBottom ? 'tail' : 'history')
        }

        let pointerResumeActive = false
        let pointerResumeUntil = 0
        let pointerResumeLatched = false
        let keyboardResumeActive = false
        let lastWheelAt = 0
        let wheelIntentUntil = 0
        let wheelLatched = false

        const hasExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            return intent.isScrollingUp && (
                pointerResumeActive
                || pointerResumeUntil >= Date.now()
                || keyboardResumeActive
                || wheelIntentUntil >= Date.now()
            )
        }

        const consumeExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            if (!hasExplicitUpwardIntent(intent)) {
                return false
            }
            if ((pointerResumeActive || pointerResumeUntil >= Date.now()) && !pointerResumeLatched) {
                pointerResumeLatched = true
                return true
            }
            if (keyboardResumeActive) {
                keyboardResumeActive = false
                return true
            }
            if (wheelIntentUntil >= Date.now() && !wheelLatched) {
                wheelLatched = true
                return true
            }
            return false
        }

        const handleScroll = () => {
            const movingUp = viewport.scrollTop < lastScrollTopRef.current
            const movingDown = viewport.scrollTop > lastScrollTopRef.current
            if (viewport.scrollTop > lastScrollTopRef.current) {
                keyboardResumeActive = false
            }
            const intent = getScrollIntent({
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                previousScrollTop: lastScrollTopRef.current
            })
            lastScrollTopRef.current = viewport.scrollTop
            if (movingUp || movingDown) {
                layoutAnchorRef.current = null
                historyDirectionRef.current = movingUp ? 'older' : 'newer'
            }

            // A slow older-page request must not restore the position from
            // when it started after the user has already scrolled elsewhere.
            // Keep the pending baseline aligned with the latest visible row;
            // the eventual prepend will preserve that row instead.
            const pending = pendingScrollRef.current
            if (pending && historyLoaderRef.current.runId === pending.runId) {
                pending.scrollTop = viewport.scrollTop
                pending.scrollHeight = viewport.scrollHeight
            }

            const needsCoverage = needsViewportCoverageRef.current()
            const needsNewerCoverage = needsNewerCoverageRef.current()
            const activeDirection = historyLoaderRef.current.direction
            if (((movingUp || movingDown) && activeDirection !== undefined && activeDirection !== historyDirectionRef.current)
                || (activeDirection === 'newer' ? !needsNewerCoverage : !needsCoverage)) {
                // Older pages retain the oldest side of the bounded window.
                // Once the user reverses toward newer history, applying this
                // request could evict their new anchor. Invalidate it instead;
                // a later fresh approach can request the page again.
                cancelActiveHistoryLoad()
            }
            // Keep the keyboard/pointer intent armed while the user moves
            // through ordinary history. Consume it only when the viewport
            // actually reaches the preload area.
            const hadExplicitUpwardIntent = hasExplicitUpwardIntent(intent)
            const explicitUpwardIntent = needsCoverage && consumeExplicitUpwardIntent(intent)

            if (isInitialScrollSettling()) {
                setShowScrollToBottom(false)
                if (shouldCancelInitialScrollSettling(intent, hadExplicitUpwardIntent)) {
                    setShowScrollToBottom(true)
                    initialScrollDeadlineRef.current = 0
                    clearInitialScrollTimers()
                    setAutoScrollMode(false)
                    setAtBottomMode(false)
                    if (explicitUpwardIntent) {
                        void requestOlderRef.current('user')
                    }
                }
                return
            }

            if (!pending && !outlineSeekPendingRef.current && !tailScrollInProgressRef.current && !isSyncingTailRef.current) {
                const plan = scrollPrefetchRef.current.sample(viewport.scrollTop, viewport.scrollHeight, viewport.clientHeight, Date.now())
                if (plan && (plan.direction === 'older' ? hasMoreMessagesRef.current : hasNewerMessagesRef.current)) {
                    void prefetchHistoryRef.current?.(plan.direction, plan.pages)
                }
            }

            // Scroll position is the source of truth. The loader controller
            // decides whether this demand may start a request; programmatic
            // scroll events cannot bypass backoff or a paused coverage run.
            if (needsCoverage && !(intent.isScrollingDown && needsNewerCoverage && hasNewerMessagesRef.current)) {
                if (movingUp) {
                    void requestOlderRef.current('user')
                }
            }
            if (movingDown && needsNewerCoverage && hasNewerMessagesRef.current && !outlineSeekPendingRef.current && !tailScrollInProgressRef.current) {
                void requestNewerRef.current('user')
            }

            if (intent.isScrollingUp && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX) {
                tailScrollInProgressRef.current = false
                setShowScrollToBottom(true)
                setAutoScrollMode(false)
                setAtBottomMode(false)
                return
            }

            if (intent.isNearBottom) {
                if (tailScrollInProgressRef.current && hasNewerMessagesRef.current) {
                    // The explicit Latest action is still fetching a new window;
                    // this is only the end of the previous history page.
                    setShowScrollToBottom(false)
                    return
                }
                tailScrollInProgressRef.current = false
                if (hasNewerMessagesRef.current || outlineSeekPendingRef.current) {
                    setShowScrollToBottom(true)
                    setAutoScrollMode(false)
                    setAtBottomMode(false)
                    return
                }
                setShowScrollToBottom(false)
                setAutoScrollMode(true)
                setAtBottomMode(true)
                return
            }

            // An explicit jump-to-tail uses native smooth scrolling. Its
            // intermediate scroll events are still far from the bottom and
            // must not be mistaken for ordinary history browsing. Keep tail
            // mode armed until the animation arrives or the user reverses it.
            if (tailScrollInProgressRef.current) {
                setShowScrollToBottom(false)
                return
            }

            setShowScrollToBottom((wasVisible) => getScrollToBottomButtonVisibility(wasVisible, intent))
            setAutoScrollMode(false)
            setAtBottomMode(false)
        }

        // At an exact edge the browser may not emit another scroll event.
        // Touch movement submits the same edge demand immediately.
        let lastTouchY: number | null = null

        const handleKeyDown = (event: KeyboardEvent) => {
            if (isNestedScrollEvent(event)) return
            if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)
                && !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
                && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)
                && !(event.target instanceof HTMLElement && event.target.isContentEditable)
                && hasNewerMessagesRef.current && needsNewerCoverageRef.current()) void requestNewerRef.current('user')
            if (!UPWARD_SCROLL_KEYS.has(event.key)) {
                keyboardResumeActive = false
            }
            const target = event.target
            if (
                event.defaultPrevented
                || event.repeat
                || event.altKey
                || event.ctrlKey
                || event.metaKey
                || !UPWARD_SCROLL_KEYS.has(event.key)
                || target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || (target instanceof HTMLElement && target.isContentEditable)
            ) {
                return
            }
            // Native keyboard scrolling can outlive a fixed intent timeout.
            // Keep this gesture armed until consumed, completed, or cancelled.
            keyboardResumeActive = true
            if (needsViewportCoverageRef.current()) {
                keyboardResumeActive = false
                void requestOlderRef.current('user')
            }
        }

        const armPointerIntent = () => {
            keyboardResumeActive = false
            pointerResumeActive = true
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (isNestedScrollEvent(event) || event.button !== 0) {
                return
            }
            armPointerIntent()
        }

        const isInsideViewport = (clientX: number, clientY: number) => {
            const rect = viewport.getBoundingClientRect()
            return clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom
        }

        // Native scrollbar interaction may bypass the viewport's own event
        // listeners. Capture pointer and mouse input at the window boundary,
        // then scope it back to the chat viewport by coordinates.
        const handleWindowPointerDown = (event: PointerEvent) => {
            if (isNestedScrollEvent(event)) return
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                armPointerIntent()
            }
        }

        const handleWindowMouseDown = (event: MouseEvent) => {
            if (isNestedScrollEvent(event)) return
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                armPointerIntent()
            }
        }

        const clearPointerIntent = () => {
            pointerResumeActive = false
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerCancel = (event: PointerEvent) => {
            if (isNestedScrollEvent(event)) return
            const hadActivePointer = pointerResumeActive
            pointerResumeActive = false
            if (hadActivePointer && (event.pointerType === 'touch' || event.pointerType === 'pen')) {
                // Native panning cancels the pointer before some mobile browsers
                // dispatch the resulting scroll event. Retain that explicit input
                // briefly so initial bottom-settling cannot reclaim the viewport.
                pointerResumeUntil = Date.now() + POINTER_CANCEL_INTENT_WINDOW_MS
                return
            }
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handleWheel = (event: WheelEvent) => {
            if (isNestedScrollEvent(event)) return
            keyboardResumeActive = false
            if (event.deltaY >= 0) {
                wheelIntentUntil = 0
                if (event.deltaY > 0 && !outlineSeekPendingRef.current && !tailScrollInProgressRef.current && needsNewerCoverageRef.current()) {
                    if (historyLoaderRef.current.direction !== 'newer') cancelActiveHistoryLoad()
                    if (hasNewerMessagesRef.current) void requestNewerRef.current('user')
                    else if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AUTO_SCROLL_RESUME_THRESHOLD_PX) {
                        setAutoScrollMode(true)
                        setAtBottomMode(true)
                    }
                }
                return
            }
            // One trigger per gesture: a trackpad swipe is a burst of wheel
            // events. Remember the gesture before the following scroll event
            // so an approach from outside the preload area is also classified
            // as explicit user intent.
            const now = Date.now()
            if (now - lastWheelAt > WHEEL_GESTURE_GAP_MS) {
                wheelLatched = false
            }
            lastWheelAt = now
            wheelIntentUntil = now + WHEEL_GESTURE_GAP_MS
            if (!needsViewportCoverageRef.current() || (wheelLatched && historyLoaderRef.current.phase !== 'idle')) {
                return
            }
            wheelLatched = true
            void requestOlderRef.current('user')
        }

        const handleTouchStart = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            keyboardResumeActive = false
            lastTouchY = event.touches[0]?.clientY ?? null
        }

        const handleTouchMove = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            const y = event.touches[0]?.clientY
            if (y !== undefined && lastTouchY !== null && y < lastTouchY - 1 && hasNewerMessagesRef.current && needsNewerCoverageRef.current()) void requestNewerRef.current('user')
            if (y !== undefined && lastTouchY !== null && y > lastTouchY + 1 && needsViewportCoverageRef.current()) void requestOlderRef.current('user')
            lastTouchY = y ?? null
        }

        const handleTouchEnd = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            lastTouchY = null
        }

        const handleTouchCancel = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            lastTouchY = null
        }

        const clearKeyboardIntent = () => {
            keyboardResumeActive = false
        }
        const handleScrollEnd = (event: Event) => {
            if (event.target !== viewport) return
            // Recheck the final geometry before retiring unconsumed demand.
            if (keyboardResumeActive && needsViewportCoverageRef.current()) {
                void requestOlderRef.current('user')
            }
            clearKeyboardIntent()
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        viewport.addEventListener('scrollend', handleScrollEnd)
        viewport.addEventListener('focusout', clearKeyboardIntent)
        viewport.addEventListener('keydown', handleKeyDown)
        viewport.addEventListener('pointerdown', handlePointerDown, { passive: true })
        viewport.addEventListener('wheel', handleWheel, { passive: true })
        viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
        viewport.addEventListener('touchmove', handleTouchMove, { passive: true })
        viewport.addEventListener('touchend', handleTouchEnd, { passive: true })
        viewport.addEventListener('touchcancel', handleTouchCancel, { passive: true })
        window.addEventListener('pointerdown', handleWindowPointerDown, { capture: true, passive: true })
        window.addEventListener('mousedown', handleWindowMouseDown, { capture: true, passive: true })
        window.addEventListener('pointerup', clearPointerIntent, { passive: true })
        window.addEventListener('mouseup', clearPointerIntent, { passive: true })
        window.addEventListener('pointercancel', handlePointerCancel, { passive: true })
        window.addEventListener('blur', clearPointerIntent)
        window.addEventListener('blur', clearKeyboardIntent)
        return () => {
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('scrollend', handleScrollEnd)
            viewport.removeEventListener('focusout', clearKeyboardIntent)
            viewport.removeEventListener('keydown', handleKeyDown)
            viewport.removeEventListener('pointerdown', handlePointerDown)
            viewport.removeEventListener('wheel', handleWheel)
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
            viewport.removeEventListener('touchend', handleTouchEnd)
            viewport.removeEventListener('touchcancel', handleTouchCancel)
            window.removeEventListener('pointerdown', handleWindowPointerDown, true)
            window.removeEventListener('mousedown', handleWindowMouseDown, true)
            window.removeEventListener('pointerup', clearPointerIntent)
            window.removeEventListener('mouseup', clearPointerIntent)
            window.removeEventListener('pointercancel', handlePointerCancel)
            window.removeEventListener('blur', clearPointerIntent)
            window.removeEventListener('blur', clearKeyboardIntent)
        }
    }, []) // Stable: no dependencies, reads from refs

    const scrollToBottomInstant = useCallback(() => {
        const viewport = viewportRef.current
        setShowScrollToBottom(false)
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
            lastScrollTopRef.current = viewport.scrollTop
        }
    }, [])

    const scrollToBottomSmooth = useCallback(() => {
        const viewport = viewportRef.current
        const content = contentRef.current
        if (!viewport) {
            return
        }
        if (content && typeof content.scrollIntoView === 'function') {
            content.scrollIntoView({ block: 'end', behavior: 'smooth' })
        } else {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }
    }, [])

    const handleNestedScrollFollowChange = useCallback((followLatest: boolean) => {
        if (!followLatest) {
            clearInitialScrollTimers()
        }
        autoScrollEnabledRef.current = followLatest && atBottomRef.current
    }, [clearInitialScrollTimers])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        outlineNavigationRef.current += 1
        stopHistoryForNavigation()
        outlineSeekPendingRef.current = false
        closingOutlineNavigationRef.current = null
        setOutlineNavigating(false)
        pendingReadingPositionRef.current = null
        const viewport = viewportRef.current
        setShowScrollToBottom(false)
        if (viewport) {
            tailScrollInProgressRef.current = true
            // Match outline navigation's native smooth-scroll path. Keep
            // instant tail-following disabled until the smooth animation
            // reaches the bottom, otherwise a resize/state update can snap
            // the viewport there before the animation is visible.
            autoScrollEnabledRef.current = false
            scrollToBottomSmooth()
            lastScrollTopRef.current = viewport.scrollTop
        }
        if (!atBottomRef.current) {
            atBottomRef.current = true
            onViewModeChangeRef.current('tail')
        }
    }, [scrollToBottomSmooth, stopHistoryForNavigation])

    // Reset state when session changes
    useLayoutEffect(() => {
        const saved = getConversationReadingPosition(props.sessionId)
        scrollPrefetchRef.current = new HistoryScrollPrefetch()
        const restoringHistory = saved?.atBottom === false
        pendingReadingPositionRef.current = restoringHistory ? saved : null
        outlineNavigationRef.current += 1
        setShowScrollToBottom(restoringHistory)
        autoScrollEnabledRef.current = !restoringHistory
        tailScrollInProgressRef.current = false
        lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
        atBottomRef.current = !restoringHistory
        onViewModeChangeRef.current(restoringHistory ? 'history' : 'tail')
        forceScrollTokenRef.current = props.forceScrollToken
        pendingScrollRef.current = null
        layoutAnchorRef.current = null
        historyDirectionRef.current = 'older'
        noProgressPagesRef.current = 0
        historyLoaderRef.current = {
            runId: historyLoaderRef.current.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: false
        }
        initialScrollSessionRef.current = null
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        settlePendingLoad('transient-stop')
    }, [
        props.sessionId,
        clearInitialScrollTimers,
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        settlePendingLoad
    ])

    useLayoutEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return
        let timer: number | null = null
        const save = () => {
            if (pendingReadingPositionRef.current) return
            saveConversationReadingPosition(props.sessionId, {
                anchor: captureScrollAnchor(viewport),
                scrollTop: viewport.scrollTop,
                atBottom: atBottomRef.current && autoScrollEnabledRef.current,
            })
        }
        const scheduleSave = () => {
            if (timer !== null) window.clearTimeout(timer)
            timer = window.setTimeout(save, 120)
        }
        viewport.addEventListener('scroll', scheduleSave, { passive: true })
        window.addEventListener('pagehide', save)
        return () => {
            if (timer !== null) window.clearTimeout(timer)
            save()
            viewport.removeEventListener('scroll', scheduleSave)
            window.removeEventListener('pagehide', save)
        }
    }, [props.sessionId])

    useLayoutEffect(() => {
        if (
            initialScrollSessionRef.current === props.sessionId
            || props.isSyncingTail
            || props.rawMessagesCount === 0
            || pendingScrollRef.current
        ) {
            return
        }

        const saved = pendingReadingPositionRef.current
        if (saved && !saved.atBottom) {
            const viewport = viewportRef.current
            if (!viewport || viewport.querySelector(MESSAGE_ANCHOR_SELECTOR) === null) return
            if (!saved.anchor || !restoreScrollAnchor(viewport, saved.anchor)) viewport.scrollTop = saved.scrollTop
            pendingReadingPositionRef.current = null
            initialScrollSessionRef.current = props.sessionId
            lastScrollTopRef.current = viewport.scrollTop
            setShowScrollToBottom(true)
            return
        }

        initialScrollSessionRef.current = props.sessionId
        autoScrollEnabledRef.current = true
        atBottomRef.current = true
        onViewModeChangeRef.current('tail')
        scrollToBottomInstant()

        initialScrollDeadlineRef.current = Date.now() + INITIAL_SCROLL_SETTLE_MS
        clearInitialScrollTimers()
        initialScrollTimersRef.current = INITIAL_SCROLL_SETTLE_DELAYS_MS.map((delay) => window.setTimeout(() => {
            if (
                initialScrollSessionRef.current !== props.sessionId
                || !autoScrollEnabledRef.current
                || pendingScrollRef.current
            ) {
                return
            }
            scrollToBottomInstant()
        }, delay))
    }, [
        props.sessionId,
        props.isSyncingTail,
        props.rawMessagesCount,
        props.messagesVersion,
        appliedMessagesVersion,
        scrollToBottomInstant,
        clearInitialScrollTimers
    ])

    useEffect(() => {
        return () => {
            outlineNavigationRef.current += 1
            historyLoaderRef.current.runId += 1
            clearInitialScrollTimers()
            clearCoverageCheckTimer()
            clearFailureRetryTimer()
            settlePendingLoad('transient-stop')
        }
    }, [clearInitialScrollTimers, clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        scrollToBottom()
    }, [props.forceScrollToken, scrollToBottom])

    const needsViewportCoverage = useCallback((): boolean => {
        const viewport = viewportRef.current
        const sentinel = topSentinelRef.current
        if (!viewport || !sentinel) {
            return false
        }
        const viewportRect = viewport.getBoundingClientRect()
        const sentinelRect = sentinel.getBoundingClientRect()
        return shouldLoadOlderForViewport({
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            viewportTop: viewportRect.top,
            sentinelTop: sentinelRect.top,
            sentinelBottom: sentinelRect.bottom
        })
    }, [])
    needsViewportCoverageRef.current = needsViewportCoverage
    const needsNewerCoverage = useCallback(() => {
        const viewport = viewportRef.current
        return Boolean(viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= HISTORY_PRELOAD_MARGIN_PX)
    }, [])
    needsNewerCoverageRef.current = needsNewerCoverage
    const needsHistoryCoverage = useCallback((direction?: 'older' | 'newer') => direction === 'newer' ? needsNewerCoverage() : needsViewportCoverage(), [needsNewerCoverage, needsViewportCoverage])

    const scheduleCoverageAfterSettling = useCallback((direction = historyDirectionRef.current) => {
        clearCoverageCheckTimer()
        if (historyLoaderRef.current.autoPaused || outlineSeekPendingRef.current || tailScrollInProgressRef.current) {
            return
        }
        const yieldDelay = noProgressPagesRef.current >= 2 ? Math.min(1000, 100 * noProgressPagesRef.current) : 0
        const delay = Math.max(yieldDelay, getHistoryCoverageRetryDelay(initialScrollDeadlineRef.current, Date.now()))
        coverageCheckTimerRef.current = window.setTimeout(() => {
            coverageCheckTimerRef.current = null
            if (direction === historyDirectionRef.current && needsHistoryCoverage(direction)) {
                void (direction === 'newer' ? requestNewerRef : requestOlderRef).current('coverage')
            }
        }, delay)
    }, [clearCoverageCheckTimer, needsHistoryCoverage])

    const startHistoryLoadAttempt = useCallback((runId: number): void => {
        const state = historyLoaderRef.current
        if (state.runId !== runId || !pendingLoadPromiseRef.current) {
            return
        }
        const finishStoppedAttempt = (
            current: HistoryLoaderState,
            result: Exclude<OlderHistoryLoadResult, 'loaded'>,
            autoPaused = current.autoPaused
        ) => {
            clearFailureRetryTimer()
            pendingScrollRef.current = null
            historyLoaderRef.current = {
                ...current,
                phase: 'idle',
                source: null,
                failureCount: 0,
                autoPaused
            }
            settlePendingLoad(result)
            if (
                result === 'transient-stop'
                && !isSyncingTailRef.current
                && !isLoadingMoreRef.current
            ) {
                scheduleCoverageAfterSettling()
            }
        }

        if (state.source !== 'consumer' && !needsHistoryCoverage(state.direction)) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (isSyncingTailRef.current || isLoadingMoreRef.current) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (state.direction === 'newer' ? !hasNewerMessagesRef.current || !onLoadNewerRef.current : !hasMoreMessagesRef.current) {
            finishStoppedAttempt(state, 'terminal-stop', true)
            return
        }

        const viewport = viewportRef.current
        if (!viewport) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }

        clearFailureRetryTimer()
        pendingScrollRef.current = {
            runId,
            anchor: captureScrollAnchor(viewport),
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            targetHistoryVersion: null,
            direction: state.direction
        }
        autoScrollEnabledRef.current = false
        historyLoaderRef.current = { ...state, phase: 'loading' }

        void (async () => {
            let outcome: OlderLoadOutcome
            try {
                const load = state.direction === 'newer' ? onLoadNewerRef.current! : onLoadMoreRef.current
                outcome = await load((historyVersion) => {
                    const current = historyLoaderRef.current
                    const pending = pendingScrollRef.current
                    if (
                        current.runId !== runId
                        || !pendingLoadPromiseRef.current
                        || !pending
                        || pending.runId !== runId
                    ) {
                        return false
                    }
                    if (current.source !== 'consumer' && !needsHistoryCoverage(current.direction)) {
                        return false
                    }
                    const viewport = viewportRef.current
                    if (viewport) {
                        pending.anchor = captureScrollAnchor(viewport)
                        pending.scrollTop = viewport.scrollTop
                        pending.scrollHeight = viewport.scrollHeight
                    }
                    pending.targetHistoryVersion = historyVersion
                    historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                    return true
                })
            } catch (error) {
                outcome = {
                    kind: 'failed',
                    error: error instanceof Error
                        ? error
                        : new Error('Failed to load older messages')
                }
            }

            const current = historyLoaderRef.current
            if (current.runId !== runId || !pendingLoadPromiseRef.current) {
                return
            }

            if (outcome.kind === 'applied') {
                const pending = pendingScrollRef.current
                if (!pending || pending.runId !== runId) {
                    finishStoppedAttempt(current, 'transient-stop')
                    return
                }
                pending.targetHistoryVersion = outcome.historyVersion
                historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                return
            }

            pendingScrollRef.current = null
            if (outcome.kind === 'failed') {
                const failureCount = current.failureCount + 1
                console.error('Failed to load older messages:', outcome.error)
                if (failureCount <= MAX_COVERAGE_LOAD_RETRIES) {
                    historyLoaderRef.current = {
                        ...current,
                        phase: 'backoff',
                        failureCount
                    }
                    const delay = COVERAGE_FAILURE_RETRY_DELAY_MS * failureCount
                    failureRetryTimerRef.current = window.setTimeout(() => {
                        failureRetryTimerRef.current = null
                        const retryState = historyLoaderRef.current
                        if (retryState.runId !== runId || retryState.phase !== 'backoff') {
                            return
                        }
                        startHistoryLoadAttemptRef.current(runId)
                    }, delay)
                    return
                }
                finishStoppedAttempt(current, 'terminal-stop', true)
                return
            }

            const terminalStop = outcome.reason === 'epoch-reset'
                || outcome.reason === 'exhausted'
                || outcome.reason === 'unavailable'
            finishStoppedAttempt(
                current,
                terminalStop ? 'terminal-stop' : 'transient-stop',
                terminalStop ? true : current.autoPaused
            )
        })()
    }, [
        clearFailureRetryTimer,
        needsHistoryCoverage,
        scheduleCoverageAfterSettling,
        settlePendingLoad
    ])
    startHistoryLoadAttemptRef.current = startHistoryLoadAttempt

    const requestOlder = useCallback((source: HistoryLoadSource, direction: 'older' | 'newer' = 'older'): Promise<OlderHistoryLoadResult> => {
        if (source === 'user') {
            noProgressPagesRef.current = 0
            historyDirectionRef.current = direction
            if (pendingLoadPromiseRef.current && historyLoaderRef.current.direction !== direction) {
                cancelActiveHistoryLoad()
            }
        }
        if (pendingLoadPromiseRef.current) {
            return pendingLoadPromiseRef.current
        }

        let state = historyLoaderRef.current
        if (source !== 'consumer' && (outlineSeekPendingRef.current || tailScrollInProgressRef.current)) {
            return Promise.resolve('transient-stop')
        }
        if (source === 'coverage') {
            if (direction !== historyDirectionRef.current) {
                return Promise.resolve('transient-stop')
            }
            if (state.autoPaused) {
                return Promise.resolve('terminal-stop')
            }
            if (isInitialScrollSettling() || !needsHistoryCoverage(direction)) {
                return Promise.resolve('transient-stop')
            }
        } else {
            // Explicit consumers must not be swallowed by the initial
            // scroll-to-bottom settling window.
            initialScrollDeadlineRef.current = 0
            clearInitialScrollTimers()
            if (source === 'user' && state.autoPaused) {
                state = { ...state, autoPaused: false }
                historyLoaderRef.current = state
            }
        }

        if (
            state.phase !== 'idle'
            || isSyncingTailRef.current
            || isLoadingMoreRef.current
            || !viewportRef.current
        ) {
            return Promise.resolve('transient-stop')
        }
        if (direction === 'newer' ? !hasNewerMessagesRef.current || !onLoadNewerRef.current : !hasMoreMessagesRef.current) {
            return Promise.resolve('terminal-stop')
        }

        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        const runId = state.runId + 1
        if (source !== 'consumer') {
            historyDirectionRef.current = direction
        }
        setHistoryLoading(true)
        historyLoaderRef.current = {
            runId,
            phase: 'loading',
            source,
            direction,
            failureCount: 0,
            autoPaused: source === 'user' ? false : state.autoPaused
        }
        const loadPromise = new Promise<OlderHistoryLoadResult>((resolve) => {
            pendingLoadResolveRef.current = resolve
        })
        pendingLoadPromiseRef.current = loadPromise
        startHistoryLoadAttemptRef.current(runId)
        return loadPromise
    }, [
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        clearInitialScrollTimers,
        cancelActiveHistoryLoad,
        isInitialScrollSettling,
        needsHistoryCoverage
    ])
    requestOlderRef.current = requestOlder
    requestNewerRef.current = source => requestOlder(source, 'newer')

    const loadOlderFromConsumer = useCallback((): Promise<OlderHistoryLoadResult> => {
        return requestOlder('consumer')
    }, [requestOlder])

    const handleOutlineSelect = useCallback(async (item: ConversationOutlineItem) => {
        const runId = ++outlineNavigationRef.current
        const sessionId = props.sessionId
        const isCurrent = () => outlineNavigationRef.current === runId && sessionIdRef.current === sessionId
        const findTarget = () => {
            const target = document.getElementById(getConversationMessageAnchorId(item.targetMessageId))
            return target && viewportRef.current?.contains(target) ? target : null
        }
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        stopHistoryForNavigation()
        autoScrollEnabledRef.current = false
        tailScrollInProgressRef.current = false
        atBottomRef.current = false
        onViewModeChangeRef.current('history')
        outlineSeekPendingRef.current = true
        closingOutlineNavigationRef.current = null
        setOutlineNavigating(true)
        setOutlineNavigationError(null)
        try {
            if (!findTarget() && (!props.onLocateOutlineItem || !await props.onLocateOutlineItem(item, isCurrent))) return
            if (!isCurrent()) return
            const target = await revealConversationMessage({ targetMessageId: item.targetMessageId, viewport: () => viewportRef.current, isCurrent })
            if (!isCurrent()) return
            if (!target) { setOutlineNavigationError(t('session.outline.locateFailed')); return }
            // Closing a mobile outline restores the composer and changes the
            // chat height. Confirm visibility again in that final layout.
            closingOutlineNavigationRef.current = runId
            props.onOutlineOpenChange(false)
            const visible = await revealConversationMessage({
                targetMessageId: item.targetMessageId,
                viewport: () => viewportRef.current,
                isCurrent,
                ready: () => !outlineOpenRef.current,
            })
            if (visible && isCurrent()) {
                setShowScrollToBottom(true)
                lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
                props.onOutlineItemClick?.(item)
            } else if (isCurrent()) {
                setOutlineNavigationError(t('session.outline.locateFailed'))
                props.onOutlineOpenChange(true)
            }
        } catch (error) {
            if (isCurrent()) setOutlineNavigationError(error instanceof Error ? error.message : String(error))
        } finally {
            if (isCurrent()) {
                outlineSeekPendingRef.current = false
                closingOutlineNavigationRef.current = null
                setOutlineNavigating(false)
                historyLoaderRef.current = { ...historyLoaderRef.current, autoPaused: false }
                scheduleCoverageAfterSettling()
            }
        }
    }, [clearInitialScrollTimers, stopHistoryForNavigation, scheduleCoverageAfterSettling, props.sessionId, props.onLocateOutlineItem, props.onOutlineItemClick, props.onOutlineOpenChange, t])

    useEffect(() => {
        if (!props.outlineOpen) {
            if (closingOutlineNavigationRef.current === outlineNavigationRef.current) return
            outlineNavigationRef.current += 1
            if (outlineSeekPendingRef.current) { outlineSeekPendingRef.current = false; stopHistoryForNavigation() }
            setOutlineNavigating(false)
            historyLoaderRef.current = { ...historyLoaderRef.current, autoPaused: false }
            scheduleCoverageAfterSettling()
        }
    }, [props.outlineOpen, stopHistoryForNavigation, scheduleCoverageAfterSettling])

    useEffect(() => {
        if (
            props.isSyncingTail
            || props.isLoadingMoreMessages
        ) {
            clearCoverageCheckTimer()
            return
        }
        const direction = historyDirectionRef.current
        if (direction === 'newer' ? !props.hasNewerMessages || !needsNewerCoverage() : !props.hasMoreMessages || !needsViewportCoverage()) {
            return
        }
        if (isInitialScrollSettling()) {
            scheduleCoverageAfterSettling(direction)
            return
        }
        scheduleCoverageAfterSettling(direction)
    }, [
        props.hasMoreMessages,
        props.hasNewerMessages,
        props.isSyncingTail,
        props.isLoadingMoreMessages,
        props.messagesVersion,
        isInitialScrollSettling,
        needsViewportCoverage,
        needsNewerCoverage,
        scheduleCoverageAfterSettling,
        clearCoverageCheckTimer
    ])

    useEffect(() => {
        const content = contentRef.current
        if (!content || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            const viewport = viewportRef.current
            if (!viewport) {
                return
            }
            // Message DOM can grow after messagesVersion commits (assistant-ui
            // updates its external runtime in an effect, then markdown/tool
            // content may resize). Keep a smooth tail jump aligned with the
            // newest content until it reaches the bottom; otherwise the
            // browser's original smooth-scroll target can become stale.
            if (tailScrollInProgressRef.current && !pendingScrollRef.current) {
                scrollToBottomSmooth()
            } else if (
                autoScrollEnabledRef.current
                && atBottomRef.current
                && !pendingScrollRef.current
            ) {
                scrollToBottomInstant()
            } else if (!pendingScrollRef.current && layoutAnchorRef.current) {
                restoreScrollAnchor(viewport, layoutAnchorRef.current)
                lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
            }
            // Late content growth can leave the viewport near the top without
            // a scroll event. Submit demand through the same controller; an
            // in-flight load, backoff, or paused run remains exclusive.
            if (!pendingScrollRef.current) {
                scheduleCoverageAfterSettling()
            }
        })
        observer.observe(content)
        return () => observer.disconnect()
    }, [
        scrollToBottomInstant,
        scrollToBottomSmooth,
        isInitialScrollSettling,
        needsViewportCoverage,
        scheduleCoverageAfterSettling
    ])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        if (pending) {
            if (
                pending.targetHistoryVersion === null
                || appliedHistoryVersion < pending.targetHistoryVersion
            ) {
                return
            }
            const restoredByAnchor = pending.anchor ? restoreScrollAnchor(viewport, pending.anchor) : false
            if (!restoredByAnchor) {
                // Total scrollHeight mixes prepends with opposite-end eviction.
                // Keep the current offset rather than applying that false delta.
                viewport.scrollTop = pending.scrollTop
            }
            layoutAnchorRef.current = pending.anchor
            const extent = pending.direction === 'newer'
                ? (viewport.scrollHeight - viewport.scrollTop) - (pending.scrollHeight - pending.scrollTop)
                : viewport.scrollTop - pending.scrollTop
            noProgressPagesRef.current = extent > 1 ? 0 : noProgressPagesRef.current + 1
            const loaderState = historyLoaderRef.current
            if (loaderState.runId !== pending.runId || loaderState.phase !== 'awaiting-render') {
                pendingScrollRef.current = null
                return
            }
            lastScrollTopRef.current = viewport.scrollTop
            pendingScrollRef.current = null
            clearFailureRetryTimer()
            historyLoaderRef.current = {
                ...loaderState,
                phase: 'idle',
                source: null,
                failureCount: 0,
                autoPaused: false
            }
            settlePendingLoad('loaded')
            scheduleCoverageAfterSettling()
            return
        }
        if (atBottomRef.current && autoScrollEnabledRef.current) {
            scrollToBottomInstant()
        }
    }, [
        appliedMessagesVersion,
        appliedHistoryVersion,
        scrollToBottomInstant,
        settlePendingLoad,
        clearFailureRetryTimer,
        scheduleCoverageAfterSettling
    ])

    const showSkeleton = props.isSyncingTail && props.rawMessagesCount === 0
    const handleShareTurn = useCallback((
        messageTarget: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: ShareTurnSnapshot
    ) => {
        const content = contentRef.current
        if (!content) return
        const messageContainer = content.querySelector<HTMLElement>('.happy-thread-messages')
        const sourceContentWidth = messageContainer?.getBoundingClientRect().width
            ?? content.getBoundingClientRect().width

        let target: HTMLElement | null = typeof messageTarget === 'string'
            ? document.getElementById(messageTarget)
            : messageTarget
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            target = findNearestMessageElement(content, clientY)
        }
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            setShareTurn({
                id: ++shareTurnIdRef.current,
                snapshots: fallbackSnapshot ? [fallbackSnapshot] : [],
                sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
            })
            return
        }

        let start: Element | null = target
        while (start?.previousElementSibling && start.getAttribute('data-hapi-message-role') !== 'user') {
            start = start.previousElementSibling
        }
        if (!start || start.getAttribute('data-hapi-message-role') !== 'user') {
            start = target
        }

        const snapshots: ShareTurnSnapshot[] = []
        let current: Element | null = start
        while (current instanceof HTMLElement) {
            if (current !== start && current.getAttribute('data-hapi-message-role') === 'user') {
                break
            }
            const role = current.getAttribute('data-hapi-message-role')
            if (role === 'user' || role === 'assistant') {
                snapshots.push({
                    html: current.outerHTML,
                    text: (current.innerText || current.textContent || '').trim()
                })
            }
            current = current.nextElementSibling
        }

        if (snapshots.length === 0 && target instanceof HTMLElement) {
            snapshots.push({
                html: target.outerHTML,
                text: (target.innerText || target.textContent || '').trim()
            })
        }
        if (snapshots.length === 0 && fallbackSnapshot) {
            snapshots.push(fallbackSnapshot)
        }
        const completeSnapshots = prependMissingUserSnapshot(snapshots, fallbackSnapshot)

        setShareTurn({
            id: ++shareTurnIdRef.current,
            snapshots: completeSnapshots,
            sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
        })
    }, [props.session])

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            terminalToolDisplayMode,
            showSessionSummaryInChat,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            codexPlanProposalId: props.session.active && props.session.metadata?.capabilities?.concurrentClients
                ? props.session.agentState?.codexPlanProposalId : null,
            onContinuePlan: props.onContinuePlan,
            onRetryMessage: props.onRetryMessage,
            historyActionPending: props.historyActionPending,
            onForkConversation: props.onForkConversation,
            onRewindConversation: props.onRewindConversation,
            isLatestCompletedBoundary: props.isLatestCompletedBoundary,
            onShareTurn: handleShareTurn,
            hasMoreMessages: props.hasMoreMessages,
            isSyncingTail: props.isSyncingTail,
            isLoadingMoreMessages: props.isLoadingMoreMessages,
            onNestedScrollFollowChange: handleNestedScrollFollowChange,
            loadOlderMessagesPreservingScroll: loadOlderFromConsumer
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                {!props.isSyncingTail && (
                    props.isLoadingMoreMessages || historyLoading || outlineNavigating
                ) ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur"
                    >
                        <Spinner size="sm" label={null} className="text-current" />
                        <span>{t('misc.loading')}</span>
                    </div>
                ) : null}
                <ThreadPrimitive.Viewport
                    asChild
                    autoScroll={false}
                    scrollToBottomOnInitialize={false}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnThreadSwitch={false}
                >
                    <div
                        ref={viewportRef}
                        className="app-scroll-y chat-scroll-y scrollbar-auto-hide min-h-0 flex-1 overflow-x-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]"
                        tabIndex={0}
                        style={{ overflowAnchor: 'none' }}
                    >
                        <div ref={contentRef} className="chat-scroll-content mx-auto w-full max-w-content min-w-0 p-3">
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {showSkeleton ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.messagesWarning ? (
                                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                                            {props.messagesWarning}
                                        </div>
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="happy-thread-messages flex flex-col gap-3">
                                <ThreadMessagesById components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <SelectedTextQuote scope={contentRef} />
                <NewMessagesIndicator count={props.unseenCount} onClick={scrollToBottom} />
                {shouldRenderScrollToBottomButton(showScrollToBottom, props.unseenCount) ? (
                    <ScrollToBottomButton onClick={scrollToBottom} />
                ) : null}
                {props.outlineOpen ? (
                    <>
                        <button
                            type="button"
                            className="absolute inset-0 z-20 bg-black/20"
                            aria-label={t('session.outline.close')}
                            onClick={() => props.onOutlineOpenChange(false)}
                        />
                        <ConversationOutlinePanel
                            items={props.outlineItems}
                            hasMoreMessages={props.outlineHasEarlier ?? props.hasMoreMessages}
                            isLoadingMoreMessages={Boolean(props.outlineLoading ?? props.isLoadingMoreMessages) || outlineNavigating}
                            error={outlineNavigationError || props.outlineError}
                            capped={props.outlineCapped}
                            scannedPages={props.outlineScannedPages}
                            onLoadMore={() => {
                                if (props.onLoadEarlierOutline) void props.onLoadEarlierOutline()
                                else void loadOlderFromConsumer()
                            }}
                            onSelect={handleOutlineSelect}
                            onClose={() => props.onOutlineOpenChange(false)}
                        />
                    </>
                ) : null}
                <ShareTurnDialog
                    key={shareTurn?.id ?? 'closed'}
                    isOpen={shareTurn !== null}
                    title={shareTitle}
                    metadataItems={shareMetadataItems}
                    sourceSnapshots={shareTurn?.snapshots ?? []}
                    sourceContentWidth={shareTurn?.sourceContentWidth ?? null}
                    onClose={() => setShareTurn(null)}
                />
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
