import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({ machines: [] })
}))

vi.mock('@assistant-ui/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@assistant-ui/react')>()
    return {
        ...actual,
        useAuiState: (selector: (state: unknown) => unknown) => selector({
            thread: { extras: undefined },
            composer: { text: '' }
        }),
        unstable_useThreadMessageIds: () => [],
        ThreadPrimitive: {
            ...actual.ThreadPrimitive,
            Root: ({ children, className }: PropsWithChildren<{ className?: string }>) => (
                <div className={className}>{children}</div>
            ),
            Viewport: ({ children }: PropsWithChildren) => children,
            Messages: () => null
        }
    }
})

import { HappyThread } from '@/components/AssistantChat/HappyThread'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { clearConversationReadingPosition, saveConversationReadingPosition } from '@/lib/conversation-reading-position'
import type { ConversationOutlineItem } from '@/chat/outline'
import type { OlderLoadOutcome } from '@/lib/message-window-store'

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
let resizeCallbacks: Array<() => void> = []

class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
    }

    observe() {}

    disconnect() {}
}

function renderThread(onViewModeChange = vi.fn(), unseenCount = 0, hasNewerMessages = false, outline: {
    item?: ConversationOutlineItem
    locate?: () => Promise<boolean>
    onOpenChange?: (open: boolean) => void
    loadNewer?: (beforeApply?: (version: number) => boolean) => Promise<OlderLoadOutcome>
    prefetch?: (direction: 'older' | 'newer', pages?: number) => Promise<void>
} = {}) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    let outlineOpen = Boolean(outline.item)
    let result: ReturnType<typeof render>
    const renderHappyThread = (forceScrollToken: number, messagesVersion = 1) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <HappyThread
                    api={{ getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false }) } as unknown as ApiClient}
                    session={{ metadata: {} } as Session}
                    sessionId="mobile-scroll-session"
                    metadata={null}
                    disabled={false}
                    onRefresh={vi.fn()}
                    onViewModeChange={onViewModeChange}
                    isSyncingTail={false}
                    messagesWarning={null}
                    hasMoreMessages={false}
                    hasNewerMessages={hasNewerMessages}
                    isLoadingMoreMessages={false}
                    onLoadMore={vi.fn().mockResolvedValue({ status: 'exhausted' })}
                    onLoadNewer={outline.loadNewer}
                    onPrefetchHistory={outline.prefetch}
                    onCancelLoadMore={vi.fn()}
                    unseenCount={unseenCount}
                    rawMessagesCount={1}
                    normalizedMessagesCount={1}
                    messagesVersion={messagesVersion}
                    historyVersion={messagesVersion - 1}
                    forceScrollToken={forceScrollToken}
                    outlineOpen={outlineOpen}
                    outlineItems={outline.item ? [outline.item] : []}
                    onLocateOutlineItem={outline.locate}
                    onOutlineOpenChange={open => {
                        outlineOpen = open
                        outline.onOpenChange?.(open)
                        result.rerender(renderHappyThread(forceScrollToken, messagesVersion))
                    }}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
    result = render(renderHappyThread(0))
    const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')
    if (!viewport) {
        throw new Error('Chat viewport was not rendered')
    }
    Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 1_232 },
        clientHeight: { configurable: true, value: 530 }
    })
    act(() => {
        vi.advanceTimersByTime(0)
    })
    return {
        ...result,
        viewport,
        onViewModeChange,
        rerenderThread: (forceScrollToken: number) => result.rerender(renderHappyThread(forceScrollToken)),
        rerenderMessages: (version: number) => result.rerender(renderHappyThread(0, version))
    }
}

beforeEach(() => {
    clearConversationReadingPosition('mobile-scroll-session')
    vi.useFakeTimers()
    resizeCallbacks = []
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: TestResizeObserver
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        writable: true,
        value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
            const requestedTop = typeof options === 'number' ? y ?? 0 : options.top ?? 0
            const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight)
            this.scrollTop = Math.min(Math.max(0, requestedTop), maxScrollTop)
        }
    })
})

afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
    } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
    if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
    if (originalResizeObserver) {
        Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver)
    } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
})

describe('mobile initial scroll settling', () => {
    it('looks ahead during fast scrolling before foreground edge loading is needed', () => {
        const prefetch = vi.fn().mockResolvedValue(undefined)
        const loadNewer = vi.fn()
        const { viewport } = renderThread(vi.fn(), 0, true, { prefetch, loadNewer })
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 5000 })
        act(() => { vi.advanceTimersByTime(2000) })
        viewport.scrollTop = 3000
        fireEvent.scroll(viewport)
        act(() => { vi.advanceTimersByTime(16) })
        viewport.scrollTop = 3600
        fireEvent.scroll(viewport)
        expect(prefetch).toHaveBeenCalledWith('newer', 2)
        expect(loadNewer).not.toHaveBeenCalled()
        expect(viewport.scrollTop).toBe(3600)
    })

    it('loads forward on a downward edge gesture and restores the visible anchor after head eviction', async () => {
        let position = 800
        let scrollHeight = 1232
        let apply!: () => void
        let publish = () => {}
        const loadNewer = vi.fn((beforeApply?: (version: number) => boolean) => new Promise<OlderLoadOutcome>(resolve => {
            apply = () => {
                expect(beforeApply?.(1)).toBe(true)
                position = 400
                scrollHeight = 1432
                publish()
                resolve({ kind: 'applied', historyVersion: 1, hasMore: true, addedRenderableCount: 5 })
            }
        }))
        const result = renderThread(vi.fn(), 0, true, { loadNewer })
        publish = () => result.rerenderMessages(2)
        const { viewport, container } = result
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => scrollHeight })
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 530, height: 530 } as DOMRect)
        const anchor = document.createElement('div')
        anchor.id = 'hapi-message-user-text:forward-anchor'
        vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({ top: position - viewport.scrollTop, bottom: position + 40 - viewport.scrollTop, height: 40 } as DOMRect))
        container.querySelector('.happy-thread-messages')!.append(anchor)
        act(() => { vi.advanceTimersByTime(2000) })
        viewport.scrollTop = 702
        fireEvent.scroll(viewport)
        const before = anchor.getBoundingClientRect().top
        fireEvent.wheel(viewport, { deltaY: 200 })
        expect(loadNewer).toHaveBeenCalledTimes(1)
        await act(async () => { apply() })
        expect(anchor.getBoundingClientRect().top).toBe(before)
        expect(viewport.scrollTop).toBe(302)
    })

    it('keeps navigation loading through delayed DOM mounting and reveals a page-end prompt after the composer returns', async () => {
        let height = 500
        const item: ConversationOutlineItem = { id: 'outline:user-text:native:page-end', targetMessageId: 'user-text:native:page-end', kind: 'user', label: 'Historical page-end prompt', createdAt: 1000 }
        const { container, viewport, onViewModeChange } = renderThread(vi.fn(), 0, true, {
            item, locate: vi.fn(async () => true), onOpenChange: open => { if (!open) height = 200 },
        })
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, value: 700 },
            clientHeight: { configurable: true, get: () => height },
        })
        vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: height, height } as DOMRect))
        await act(async () => { vi.advanceTimersByTime(2000) })
        onViewModeChange.mockClear()
        await act(async () => { fireEvent.click(container.querySelector('aside button.group')!) })
        await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
        expect(container.querySelector('aside button[aria-busy="true"]')).not.toBeNull()
        expect(container.querySelector('aside')).not.toBeNull()
        const target = document.createElement('div')
        target.id = 'hapi-message-user-text:native:page-end'
        vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ top: 650 - viewport.scrollTop, bottom: 690 - viewport.scrollTop, height: 40 } as DOMRect))
        container.querySelector('.happy-thread-messages')!.append(target)
        await act(async () => { await vi.advanceTimersByTimeAsync(150) })
        expect(container.querySelector('aside')).toBeNull()
        expect(container.querySelector('[role="status"].pointer-events-none')).not.toBeNull()
        await act(async () => { await vi.advanceTimersByTimeAsync(100) })
        expect(target.getBoundingClientRect().top).toBeLessThan(height)
        expect(target.getBoundingClientRect().bottom).toBeGreaterThan(0)
        fireEvent.scroll(viewport)
        expect(onViewModeChange).not.toHaveBeenCalledWith('tail')
    })

    it('does not replace an older window with latest when a historical page-end prompt reaches its bottom', () => {
        const { viewport, onViewModeChange, container } = renderThread(vi.fn(), 0, true)
        act(() => { vi.advanceTimersByTime(2000) })
        onViewModeChange.mockClear()
        viewport.scrollTop = 702
        fireEvent.scroll(viewport)
        expect(onViewModeChange).not.toHaveBeenCalledWith('tail')
        expect(onViewModeChange).toHaveBeenCalledWith('history')
        expect(container.querySelector('button[aria-label="Scroll to bottom"]')).not.toBeNull()
        onViewModeChange.mockClear()
        fireEvent.click(container.querySelector('button[aria-label="Scroll to bottom"]')!)
        fireEvent.scroll(viewport)
        expect(onViewModeChange).toHaveBeenCalledWith('tail')
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('restores a reading anchor after returning from a preview without settling back to the bottom', () => {
        saveConversationReadingPosition('mobile-scroll-session', {
            anchor: { id: 'restored-message', topOffset: 20 }, scrollTop: 300, atBottom: false,
        })
        const { container, viewport, rerenderMessages, onViewModeChange } = renderThread()
        const message = document.createElement('div')
        message.id = 'restored-message'
        container.querySelector('.happy-thread-messages')!.append(message)
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 530 } as DOMRect)
        vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => ({ top: 450 - viewport.scrollTop, bottom: 510 - viewport.scrollTop } as DOMRect))
        rerenderMessages(2)
        act(() => { vi.advanceTimersByTime(2000) })
        expect(viewport.scrollTop).toBe(430)
        expect(onViewModeChange).toHaveBeenCalledWith('history')
        expect(container.querySelector('button[aria-label="Scroll to bottom"]')).not.toBeNull()
    })

    it('checks the final keyboard position before clearing intent at scrollend', () => {
        const { container, viewport } = renderThread()
        const sentinel = container.querySelector('.chat-scroll-content > [aria-hidden="true"]')!
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))
        fireEvent.keyDown(viewport, { key: 'Home' })
        fireEvent.keyUp(viewport, { key: 'Home' })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        viewport.scrollTop = 0
        fireEvent(viewport, new Event('scrollend'))
        act(() => {
            vi.advanceTimersByTime(1_800)
        })
        expect(viewport.scrollTop).toBe(0)
    })

    it.each([false, true])('keeps delayed keyboard intent only until scrollend (ended=%s)', (ended) => {
        const { container, viewport, onViewModeChange } = renderThread()
        const sentinel = container.querySelector('.chat-scroll-content > [aria-hidden="true"]')!
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        fireEvent.keyDown(viewport, { key: 'Home' })
        fireEvent.keyUp(viewport, { key: 'Home' })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        if (ended) fireEvent(viewport, new Event('scrollend'))
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(ended ? 702 : 520)
        if (!ended) expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('does not snap back after pointer cancellation ends a touch swipe', () => {
        const { viewport, onViewModeChange } = renderThread()
        expect(viewport.scrollTop).toBe(702)

        const pointerDown = new Event('pointerdown', { bubbles: true })
        Object.defineProperties(pointerDown, {
            button: { value: 0 },
            pointerType: { value: 'touch' }
        })
        fireEvent(viewport, pointerDown)
        const pointerCancel = new Event('pointercancel', { bubbles: true })
        Object.defineProperty(pointerCancel, 'pointerType', { value: 'touch' })
        fireEvent(viewport, pointerCancel)

        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(520)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('keeps settling for non-explicit non-zero layout movement', () => {
        const { viewport, onViewModeChange } = renderThread()

        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('does not snap back after a window-captured native scrollbar drag', () => {
        const { viewport, onViewModeChange } = renderThread()
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: 600
        } as DOMRect)

        fireEvent.mouseDown(window, { button: 0, clientX: 319, clientY: 200 })
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        fireEvent.mouseUp(window)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(520)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('ignores captured mouse input outside the chat viewport', () => {
        const { viewport, onViewModeChange } = renderThread()
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: 600
        } as DOMRect)

        fireEvent.mouseDown(window, { button: 0, clientX: 400, clientY: 200 })
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        fireEvent.mouseUp(window)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('keeps settling after the runtime resets the viewport to the exact top', () => {
        const { viewport, onViewModeChange } = renderThread()

        viewport.scrollTop = 0
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })
})

describe('explicit tail scrolling', () => {
    it('renders the unread count inside the compact bottom control', () => {
        const { container } = renderThread(vi.fn(), 7)
        const button = container.querySelector<HTMLButtonElement>('button[aria-label*="7"]')

        expect(button).not.toBeNull()
        expect(button).toHaveClass('rounded-full', 'h-6', 'w-6')
        expect(button).toHaveClass('bg-[var(--app-button)]', 'text-[var(--app-button-text)]')
        expect(button?.querySelector('span')).toHaveClass('translate-y-px')
        expect(button?.textContent).toContain('7')
    })

    it('uses the same smooth end-alignment scroll as outline navigation', () => {
        const scrollIntoView = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView
        })
        const { rerenderThread } = renderThread()

        rerenderThread(1)

        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' })
    })

    it('retargets the smooth tail jump when content grows during the animation', () => {
        const scrollIntoView = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView
        })
        const { rerenderThread } = renderThread()

        rerenderThread(1)
        expect(scrollIntoView).toHaveBeenCalledTimes(1)

        act(() => {
            resizeCallbacks.at(-1)?.()
        })

        expect(scrollIntoView).toHaveBeenCalledTimes(2)
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'end', behavior: 'smooth' })
    })

    it('stays in tail mode through smooth-scroll progress and content growth', () => {
        const { viewport, onViewModeChange, rerenderThread } = renderThread()
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        viewport.scrollTop = 400
        fireEvent.scroll(viewport)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')

        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: vi.fn()
        })
        onViewModeChange.mockClear()
        rerenderThread(1)
        expect(onViewModeChange).toHaveBeenLastCalledWith('tail')

        viewport.scrollTop = 500
        fireEvent.scroll(viewport)
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_400 })
        viewport.scrollTop = 650
        fireEvent.scroll(viewport)

        expect(onViewModeChange).not.toHaveBeenCalledWith('history')

        viewport.scrollTop = 870
        fireEvent.scroll(viewport)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })
})
