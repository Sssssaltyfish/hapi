import { useState, useCallback, useEffect, useId, useLayoutEffect, useRef, type FC, type KeyboardEvent, type PropsWithChildren, type UIEvent } from 'react'
import {
    useAuiState,
    type ReasoningGroupProps,
    type ReasoningMessagePartComponent,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { cn } from '@/lib/utils'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { DisclosureChevron, DisclosureContent } from '@/components/ui/disclosure'
import {
    MARKDOWN_CLASSNAME,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_PLUGINS,
    MARKDOWN_REHYPE_PLUGINS,
    defaultComponents,
    denyOnlyTransform,
    UriConfirmProvider,
} from '@/components/assistant-ui/markdown-text'

function ShimmerDot() {
    return (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
    )
}

export const Reasoning: ReasoningMessagePartComponent = ({ text, status }) => {
    const previousTextRef = useRef(text)
    const runStartedWithRunningRef = useRef(status.type === 'running')
    const hasTextChangedDuringRunRef = useRef(false)

    // The runtime keeps resumed reasoning history complete until a new output
    // block exists. Once this part is actually running, preserve assistant-ui's
    // typewriter from its first paint. A complete -> running transition with
    // unchanged text is still treated as hydration, not new reasoning output.
    if (status.type !== 'running') {
        runStartedWithRunningRef.current = false
        hasTextChangedDuringRunRef.current = false
    } else if (
        text !== previousTextRef.current
    ) {
        hasTextChangedDuringRunRef.current = true
    }
    const smooth = status.type === 'running'
        && (runStartedWithRunningRef.current || hasTextChangedDuringRunRef.current)

    previousTextRef.current = text

    return (
        <UriConfirmProvider>
            <MarkdownTextPrimitive
                smooth={smooth}
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={defaultComponents}
                componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                urlTransform={denyOnlyTransform}
                className={cn(MARKDOWN_CLASSNAME, 'aui-reasoning-content')}
            />
        </UriConfirmProvider>
    )
}

type HappyReasoningGroupProps = PropsWithChildren<
    Partial<Pick<ReasoningGroupProps, 'startIndex' | 'endIndex'>>
>

export const ReasoningGroup: FC<HappyReasoningGroupProps> = ({
    children,
    startIndex = 0,
    endIndex,
}) => {
    const panelId = useId()
    const isStreaming = useAuiState((state) => {
        const parts = state.message.parts.slice(startIndex, endIndex === undefined ? undefined : endIndex + 1)
        return parts.some((part) => part.type === 'reasoning' && part.status.type === 'running')
    })
    const { reasoningCollapsed } = useReasoningCollapse()
    const [isOpen, setIsOpen] = useState(() => isStreaming && !reasoningCollapsed)
    useLayoutEffect(() => {
        if (!isStreaming) return
        setIsOpen(!reasoningCollapsed)
    }, [isStreaming, reasoningCollapsed])

    return (
        <div data-hapi-share-exclude="true" className="aui-reasoning-group my-3 overflow-hidden rounded-2xl bg-[var(--app-reasoning-bg)]">
            <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setIsOpen(open => !open)}
                className={cn(
                    'flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-xs font-medium',
                    'text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                    'transition-colors cursor-pointer select-none'
                )}
            >
                <DisclosureChevron open={isOpen} className="h-3 w-3" />
                <span>Reasoning</span>
                {isStreaming && (
                    <span className="ml-1 flex items-center gap-1 text-[var(--app-hint)]">
                        <ShimmerDot />
                    </span>
                )}
            </button>

            <DisclosureContent open={isOpen} id={panelId} keepMounted>
                <ReasoningScroll isOpen={isOpen} isStreaming={isStreaming} className="border-t border-[var(--app-divider)] px-3.5 py-3">
                    {children}
                </ReasoningScroll>
            </DisclosureContent>
        </div>
    )
}

export function ReasoningScroll({ children, isOpen, isStreaming, className }: PropsWithChildren<{
    isOpen: boolean
    isStreaming: boolean
    className?: string
}>) {
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const followLatestRef = useRef(true)
    const pointerActiveRef = useRef(false)
    const pointerCleanupRef = useRef<(() => void) | null>(null)
    const followSyncFrameRef = useRef<number | null>(null)
    const chatContext = useOptionalHappyChatContext()
    const onNestedFollowRef = useRef(chatContext?.onNestedScrollFollowChange)
    onNestedFollowRef.current = chatContext?.onNestedScrollFollowChange

    useLayoutEffect(() => {
        if (isOpen && isStreaming) followLatestRef.current = true
    }, [isOpen, isStreaming])

    useEffect(() => {
        if (isOpen || followLatestRef.current) return
        followLatestRef.current = true
        chatContext?.onNestedScrollFollowChange?.(true)
    }, [isOpen, chatContext])

    useLayoutEffect(() => {
        const scroll = scrollRef.current
        if (!scroll || !isOpen || !isStreaming || !followLatestRef.current) return
        scroll.scrollTop = scroll.scrollHeight
    })

    const syncNestedFollow = useCallback(() => {
        const scroll = scrollRef.current
        if (!scroll) return
        const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 8
        const followLatest = atBottom && !pointerActiveRef.current
        followLatestRef.current = followLatest
        chatContext?.onNestedScrollFollowChange?.(followLatest)
    }, [chatContext])

    const handleScroll = (_event: UIEvent<HTMLDivElement>) => {
        syncNestedFollow()
    }

    const claimNestedScroll = () => {
        chatContext?.onNestedScrollFollowChange?.(false)
    }

    const scheduleNestedFollowSync = () => {
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
        followSyncFrameRef.current = window.requestAnimationFrame(() => {
            followSyncFrameRef.current = null
            syncNestedFollow()
        })
    }

    const claimNestedPointerScroll = () => {
        pointerActiveRef.current = true
        followLatestRef.current = false
        claimNestedScroll()
        pointerCleanupRef.current?.()

        const finish = () => {
            pointerCleanupRef.current?.()
            pointerActiveRef.current = false
            syncNestedFollow()
        }
        const cleanup = () => {
            window.removeEventListener('pointerup', finish)
            window.removeEventListener('pointercancel', finish)
            pointerCleanupRef.current = null
        }
        pointerCleanupRef.current = cleanup
        window.addEventListener('pointerup', finish, { once: true })
        window.addEventListener('pointercancel', finish, { once: true })
    }

    const claimNestedWheelScroll = () => {
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    const claimNestedKeyboardScroll = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    useEffect(() => () => {
        pointerCleanupRef.current?.()
        if (!followLatestRef.current) onNestedFollowRef.current?.(true)
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
    }, [])

    return (
        <div
            ref={scrollRef}
            data-hapi-nested-scroll="true"
            tabIndex={isOpen ? 0 : -1}
            onScroll={handleScroll}
            onPointerDown={claimNestedPointerScroll}
            onWheel={claimNestedWheelScroll}
            onKeyDown={claimNestedKeyboardScroll}
            // Allow wheel/touch scrolling to reach the chat at panel edges.
            className={cn('aui-reasoning-scroll overflow-y-auto', className)}
        >
            {children}
        </div>
    )
}
