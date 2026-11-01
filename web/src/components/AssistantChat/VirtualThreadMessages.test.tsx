import { act, render, waitFor } from '@testing-library/react'
import { useRef, type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { getTurnRowRange, VirtualThreadMessages } from './VirtualThreadMessages'
import type { TimelineHistoryLocator, TimelineRow } from '@/lib/stable-chat-timeline'

function Message() {
    const id = useAuiState(s => s.message.id)
    const role = useAuiState(s => s.message.role)
    return <div id={`hapi-message-${id}`} data-hapi-message-role={role}>{id}</div>
}
const components = { UserMessage: Message, AssistantMessage: Message, SystemMessage: Message }
const rows: TimelineRow[] = Array.from({ length: 100 }, (_, index) => ({
    id: `row-${index}`, role: index % 4 === 0 ? 'user' : 'assistant', sourceIds: [`source-${index}`], createdAt: index, resident: true, current: true,
    locator: { kind: 'native', turnId: `turn-${index}`, itemId: `item-${index}` },
}))

function Harness(props: { rows: readonly TimelineRow[]; hydrate?: (locator: TimelineHistoryLocator) => Promise<boolean>; compoundViewportRef?: boolean }) {
    const viewport = useRef<HTMLDivElement>(null)
    const follow = useRef(false)
    const ref = useRef(null)
    const messages: ThreadMessageLike[] = props.rows.filter(row => row.resident).map(row => ({ id: row.id, role: row.role, content: [{ type: 'text', text: row.id }] }))
    const runtime = useExternalStoreRuntime({ messages, convertMessage: message => message, isRunning: false, onNew: async () => {} })
    return <AssistantRuntimeProvider runtime={runtime}>
        <div ref={props.compoundViewportRef ? node => { viewport.current = node } : viewport} data-testid="viewport"><VirtualThreadMessages ref={ref} viewport={viewport as RefObject<HTMLDivElement | null>} followLatest={follow} rows={props.rows} components={components} onHydrateHistoryRow={props.hydrate} /></div>
    </AssistantRuntimeProvider>
}

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const height = this.dataset.testid === 'viewport' ? 600 : this.hasAttribute('data-hapi-virtual-row') ? 120 : 0
        return { width: 800, height, top: 0, left: 0, right: 800, bottom: height, x: 0, y: 0, toJSON() {} }
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.testid === 'viewport' ? 600 : 120 })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.testid === 'viewport' ? 600 : 120 })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(30_000)
    vi.stubGlobal('ResizeObserver', class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(element: HTMLElement) { this.callback([{ target: element, borderBoxSize: [{ inlineSize: 800, blockSize: element.getBoundingClientRect().height }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver) }
        unobserve() {}
        disconnect() {}
    })
    HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
        this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? this.scrollTop
        queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
    }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('measured conversation virtualization', () => {
    it('retains its connected viewport through a compound parent ref detach during prepend', async () => {
        const view = render(<Harness rows={rows} compoundViewportRef />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-0')).not.toBeNull())
        // Changing composed parent refs must remain supported while prepending.
        view.rerender(<Harness rows={rows} compoundViewportRef />)
        const retained = view.container.querySelector('#hapi-message-row-0')
        const older = rows.slice(0, 14).map((row, index) => ({ ...row, id: `older-${index}`, sourceIds: [`older-source-${index}`], createdAt: index - 14 }))
        view.rerender(<Harness rows={[...older, ...rows]} compoundViewportRef />)
        await waitFor(() => expect(view.getByTestId('viewport').scrollTop).toBeGreaterThan(0))
        expect(view.container.querySelector('#hapi-message-row-0')).toBe(retained)
    })
    it('preserves the first keyed row while older logical rows are prepended at scroll offset zero', async () => {
        const view = render(<Harness rows={rows} />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-0')).not.toBeNull())
        const retained = view.container.querySelector('#hapi-message-row-0')
        const older = rows.slice(0, 14).map((row, index) => ({ ...row, id: `older-${index}`, sourceIds: [`older-source-${index}`], createdAt: index - 14 }))
        view.rerender(<Harness rows={[...older, ...rows]} />)
        await waitFor(() => expect(view.getByTestId('viewport').scrollTop).toBeGreaterThan(0))
        expect(view.container.querySelector('#hapi-message-row-0')).toBe(retained)
    })
    it('mounts a viewport neighborhood and keeps measured row geometry on payload eviction', async () => {
        const view = render(<Harness rows={rows} />)
        await waitFor(() => expect(view.container.querySelectorAll('[data-hapi-message-role]').length).toBeGreaterThan(0))
        expect(view.container.querySelectorAll('[data-hapi-message-role]').length).toBeLessThan(25)
        const retained = view.container.querySelector('#hapi-message-row-5')
        const first = view.container.querySelector<HTMLElement>('[data-hapi-virtual-row="row-0"]')!
        await waitFor(() => expect(first.dataset.hapiRowSize).toBe('120'))
        view.rerender(<Harness rows={rows.map((row, index) => index === 0 ? { ...row, resident: false } : row)} />)
        await waitFor(() => expect(first.dataset.hapiRowResident).toBe('false'))
        expect(first.style.height).toBe('120px')
        expect(view.container.querySelector('#hapi-message-row-5')).toBe(retained)
    })

    it('hydrates an unresident row demanded by the virtual range without an edge page action', async () => {
        const hydrate = vi.fn(async () => true)
        render(<Harness rows={rows.map((row, index) => index === 3 ? { ...row, resident: false } : row)} hydrate={hydrate} />)
        await waitFor(() => expect(hydrate).toHaveBeenCalledWith(rows[3]!.locator))
    })

    it('resolves tool-card scroll anchors to their logical tool-call row for navigation and restoration', async () => {
        const complete = vi.fn()
        const view = render(<Harness rows={rows.map((row, index) => index === 3 ? { ...row, sourceIds: ['tool-call:item-3'] } : row)} />)
        act(() => { view.getByTestId('viewport').dispatchEvent(new CustomEvent('hapi:ensure-row', { detail: { alias: 'tool:item-3', complete } })) })
        await waitFor(() => expect(complete).toHaveBeenCalledWith(true))
        expect(view.container.querySelector('#hapi-message-row-3')).not.toBeNull()
    })

    it('coalesces visible and navigation demand while fetching each missing piece of a response', async () => {
        let pieces = 0
        const complete = vi.fn()
        const initial = rows.map((row, index) => index === 3 ? { ...row, resident: false } : row)
        const hydrate = vi.fn(async (_locator: TimelineHistoryLocator) => {
            await new Promise(resolve => setTimeout(resolve, 0))
            pieces++
            const next = rows.map((row, index) => index === 3 && pieces === 1
                ? { ...row, resident: false, locator: { kind: 'native' as const, turnId: 'turn-3', itemId: 'piece-2' } }
                : row)
            view.rerender(<Harness rows={next} hydrate={hydrate} />)
            return true
        })
        const view = render(<Harness rows={initial} hydrate={hydrate} />)
        act(() => { view.getByTestId('viewport').dispatchEvent(new CustomEvent('hapi:ensure-row', { detail: { alias: 'source-3', complete } })) })
        await waitFor(() => expect(complete).toHaveBeenCalledWith(true))
        expect(hydrate).toHaveBeenCalledTimes(2)
        expect(hydrate.mock.calls[1]?.[0]).toEqual({ kind: 'native', turnId: 'turn-3', itemId: 'piece-2' })
    })

    it('keeps user scrolling authoritative when navigation hydration finishes after a wheel gesture', async () => {
        let release!: (loaded: boolean) => void
        const hydrate = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))
        const complete = vi.fn()
        const view = render(<Harness rows={rows.map((row, index) => index === 3 ? { ...row, resident: false } : row)} hydrate={hydrate} />)
        act(() => { view.getByTestId('viewport').dispatchEvent(new CustomEvent('hapi:ensure-row', { detail: { alias: 'source-3', complete } })) })
        await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1))
        const viewport = view.getByTestId('viewport')
        act(() => {
            viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 300 }))
            viewport.scrollTop = 777
            viewport.dispatchEvent(new Event('scroll'))
            view.rerender(<Harness rows={rows} hydrate={hydrate} />)
            release(true)
        })
        await waitFor(() => expect(complete).toHaveBeenCalledWith(false))
        expect(viewport.scrollTop).toBeGreaterThan(600)
    })

    it('materializes only resident rows for explicit selection, and releases them when selection collapses', async () => {
        const view = render(<Harness rows={rows.map((row, index) => index === 50 ? { ...row, resident: false } : row)} />)
        const complete = vi.fn()
        act(() => { view.getByTestId('viewport').dispatchEvent(new CustomEvent('hapi:materialize-selection', { detail: complete })) })
        await waitFor(() => expect(complete).toHaveBeenCalled())
        expect(view.container.querySelectorAll('[data-hapi-message-role]')).toHaveLength(99)
        act(() => { document.dispatchEvent(new Event('selectionchange')) })
        await waitFor(() => expect(view.container.querySelectorAll('[data-hapi-message-role]').length).toBeLessThan(25))
    })

    it('includes the preceding prompt and every response fragment for turn sharing', () => {
        expect(getTurnRowRange(rows, 6)).toEqual([4, 7])
        expect(getTurnRowRange(rows, 4)).toEqual([4, 7])
        expect(getTurnRowRange(rows, 99)).toEqual([96, 99])
    })
})
