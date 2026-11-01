import { act, render, waitFor } from '@testing-library/react'
import { createRef, useRef, type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { getTurnRowRange, VirtualThreadMessages, type VirtualThreadHandle } from './VirtualThreadMessages'
import type { TimelineHistoryLocator, TimelineRow } from '@/lib/stable-chat-timeline'
import { captureConversationScrollAnchor } from '@/lib/conversation-scroll-anchor'
import { createWorkExpansionState } from './workExpansion'

const work = vi.hoisted(() => ({ expansion: null as { set: (turnId: string, open: boolean) => void } | null }))
vi.mock('./context', () => ({ useOptionalWorkExpansionState: () => work.expansion }))

function Message() {
    const id = useAuiState(s => s.message.id)
    const role = useAuiState(s => s.message.role)
    return <div id={`hapi-message-${id}`} data-hapi-message-role={role} data-hapi-scroll-anchor={`source-${id.split('-').at(-1)}`}>{id}</div>
}
const components = { UserMessage: Message, AssistantMessage: Message, SystemMessage: Message }
const rows: TimelineRow[] = Array.from({ length: 100 }, (_, index) => ({
    id: `row-${index}`, role: index % 4 === 0 ? 'user' : 'assistant', sourceIds: [`source-${index}`], createdAt: index, resident: true, current: true,
    locator: { kind: 'native', turnId: `turn-${index}`, itemId: `item-${index}` },
}))

function Harness(props: { rows: readonly TimelineRow[]; hydrate?: (locator: TimelineHistoryLocator) => Promise<boolean>; compoundViewportRef?: boolean; listRef?: RefObject<VirtualThreadHandle | null> }) {
    const viewport = useRef<HTMLDivElement>(null)
    const follow = useRef(false)
    const ref = useRef(null)
    const messages: ThreadMessageLike[] = props.rows.filter(row => row.resident).map(row => ({ id: row.id, role: row.role, content: [{ type: 'text', text: row.id }] }))
    const runtime = useExternalStoreRuntime({ messages, convertMessage: message => message, isRunning: false, onNew: async () => {} })
    return <AssistantRuntimeProvider runtime={runtime}>
        <div ref={props.compoundViewportRef ? node => { viewport.current = node } : viewport} data-testid="viewport"><VirtualThreadMessages ref={props.listRef ?? ref} viewport={viewport as RefObject<HTMLDivElement | null>} followLatest={follow} rows={props.rows} components={components} onHydrateHistoryRow={props.hydrate} /></div>
    </AssistantRuntimeProvider>
}

beforeEach(() => {
    work.expansion = null
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
        constructor(_callback: ResizeObserverCallback) {}
        // Hold delivery: synchronous committed layout must establish geometry
        // before a later native ResizeObserver batch, including during a fling.
        observe() {}
        unobserve() {}
        disconnect() {}
    })
    HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
        this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? this.scrollTop
        queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
    }
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('measured conversation virtualization', () => {
    it('opens collapsed work before the actual select-all event completes', async () => {
        const set = vi.fn()
        work.expansion = { set }
        const view = render(<Harness rows={rows.slice(0, 3).map((row, index) => index === 1 ? { ...row, workTurnId: 'work-turn' } : row)} />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-1')).not.toBeNull())
        const complete = vi.fn(() => expect(set).toHaveBeenCalledWith('work-turn', true))
        act(() => view.getByTestId('viewport').dispatchEvent(new CustomEvent('hapi:materialize-selection', { detail: complete })))
        await waitFor(() => expect(complete).toHaveBeenCalledOnce())
    })
    it('preserves the actual content anchor when a partially visible predecessor expands during history loading', async () => {
        const listRef = createRef<VirtualThreadHandle>()
        const view = render(<Harness rows={rows} listRef={listRef} />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-2')).not.toBeNull())
        const viewport = view.getByTestId('viewport')
        const predecessor = view.container.querySelector<HTMLElement>('[data-hapi-virtual-row="row-0"]')!
        const intervening = view.container.querySelector<HTMLElement>('[data-hapi-virtual-row="row-1"]')!
        const anchorRow = view.container.querySelector<HTMLElement>('[data-hapi-virtual-row="row-2"]')!
        const source = view.container.querySelector<HTMLElement>('#hapi-message-row-2')!
        let height = 232
        let insertedHeight = 0
        const bounds = (top: number, size: number): DOMRect => ({ width: 800, height: size, top, bottom: top + size, left: 0, right: 800, x: 0, y: top, toJSON() {} })
        Object.defineProperty(predecessor, 'getBoundingClientRect', { configurable: true, value: () => bounds(insertedHeight - viewport.scrollTop, height) })
        Object.defineProperty(intervening, 'getBoundingClientRect', { configurable: true, value: () => bounds(insertedHeight + height - viewport.scrollTop, 36) })
        Object.defineProperty(anchorRow, 'getBoundingClientRect', { configurable: true, value: () => bounds(insertedHeight + height + 36 - viewport.scrollTop, 268) })
        Object.defineProperty(source, 'getBoundingClientRect', { configurable: true, value: () => bounds(insertedHeight + height + 40 - viewport.scrollTop, 40) })
        view.rerender(<Harness rows={[...rows]} listRef={listRef} />)
        act(() => {
            viewport.scrollTop = 300
            viewport.dispatchEvent(new Event('scroll'))
            viewport.scrollTop = 197
            viewport.dispatchEvent(new Event('scroll'))
            expect(captureConversationScrollAnchor(viewport)).toMatchObject({ id: 'source-2', kind: 'content' })
            listRef.current!.captureHistoryContentAnchor()
        })
        const readingOffset = source.getBoundingClientRect().top
        height = 323.5
        insertedHeight = 240
        const older = rows.slice(0, 2).map((row, index) => ({ ...row, id: `older-${index}`, sourceIds: [`older-source-${index}`], createdAt: index - 2 }))
        view.rerender(<Harness rows={[...older, ...rows.map((row, index) => index === 0 ? { ...row, sourceIds: [...row.sourceIds, 'history-prefix'] } : row)]} listRef={listRef} />)
        expect(viewport.scrollTop).toBe(528.5)
        expect(source.getBoundingClientRect().top).toBe(readingOffset)
        expect(anchorRow.dataset.hapiRowSize).toBe('268')
    })
    it('corrects only changes inside a response without replaying viewport coordinates over native inertia', async () => {
        const listRef = createRef<VirtualThreadHandle>()
        const view = render(<Harness rows={rows} listRef={listRef} />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-1')).not.toBeNull())
        const viewport = view.getByTestId('viewport')
        const row = view.container.querySelector<HTMLElement>('[data-hapi-virtual-row="row-1"]')!
        const source = view.container.querySelector<HTMLElement>('#hapi-message-row-1')!
        let height = 300
        let localOffset = 108
        const bounds = (top: number, size: number): DOMRect => ({ width: 800, height: size, top, bottom: top + size, left: 0, right: 800, x: 0, y: top, toJSON() {} })
        Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => bounds(120 - viewport.scrollTop, height) })
        Object.defineProperty(source, 'getBoundingClientRect', { configurable: true, value: () => bounds(120 + localOffset - viewport.scrollTop, 40) })
        view.rerender(<Harness rows={[...rows]} listRef={listRef} />)
        // Keep these commits inside the pending observer's quiet window even
        // when the test runner is busy rendering the other conversation suites.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        act(() => {
            viewport.scrollTop = 150
            viewport.dispatchEvent(new Event('scroll'))
            expect(captureConversationScrollAnchor(viewport)).toMatchObject({ id: 'source-1', kind: 'content' })
            listRef.current!.captureHistoryContentAnchor()
        })
        const extended = rows.map((row, index) => index === 1 ? { ...row, sourceIds: [...row.sourceIds, 'history-prefix'] } : row)
        view.rerender(<Harness rows={extended} listRef={listRef} />)
        act(() => {
            // The phone continues moving after touchend without a new gesture.
            viewport.scrollTop = 121
            viewport.dispatchEvent(new Event('scroll'))
        })
        view.rerender(<Harness rows={[...extended]} listRef={listRef} />)
        expect(viewport.scrollTop).toBe(121)
        localOffset += 126.5
        height += 126.5
        view.rerender(<Harness rows={[...extended]} listRef={listRef} />)
        expect(viewport.scrollTop).toBe(247.5)
        view.rerender(<Harness rows={[...extended]} listRef={listRef} />)
        expect(viewport.scrollTop).toBe(247.5)
    })
    it('keeps the reading offset consistent while several short history rows are measured in one layout batch', async () => {
        const previousRect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!
        vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
            const rect = previousRect.call(this)
            return this.dataset.hapiVirtualRow?.startsWith('older-') ? { ...rect, height: 36, bottom: 36 } : rect
        })
        const view = render(<Harness rows={rows} />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-0')).not.toBeNull())
        act(() => {
            const viewport = view.getByTestId('viewport')
            viewport.scrollTop = 300
            viewport.dispatchEvent(new Event('scroll'))
            viewport.scrollTop = 60
            viewport.dispatchEvent(new Event('scroll'))
        })
        const older = rows.slice(0, 14).map((row, index) => ({ ...row, id: `older-${index}`, sourceIds: [`older-source-${index}`], createdAt: index - 14 }))
        view.rerender(<Harness rows={[...older, ...rows]} />)
        let rowTop = 0
        for (const element of view.container.querySelectorAll<HTMLElement>('[data-hapi-virtual-row], [data-hapi-virtual-spacer]')) {
            if (element.dataset.hapiVirtualRow === 'row-0') break
            rowTop += element.hasAttribute('data-hapi-virtual-spacer') ? parseFloat(element.style.height) || 0 : element.getBoundingClientRect().height
        }
        expect(rowTop - view.getByTestId('viewport').scrollTop).toBe(-60)
    })
    it('preserves the reader when a history page expands an already measured row entirely above the fold during upward scrolling', async () => {
        const listRef = createRef<VirtualThreadHandle>()
        const view = render(<Harness rows={rows} listRef={listRef} />)
        await waitFor(() => expect(view.container.querySelector('[data-hapi-virtual-row="row-0"]')).not.toBeNull())
        const row = view.container.querySelector<HTMLElement>('[data-hapi-virtual-row="row-0"]')!
        let height = 136
        Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 800, height, top: 0, bottom: height, left: 0, right: 800, x: 0, y: 0, toJSON() {} }) })
        view.rerender(<Harness rows={[...rows]} listRef={listRef} />)
        act(() => {
            const viewport = view.getByTestId('viewport')
            viewport.scrollTop = 300
            viewport.dispatchEvent(new Event('scroll'))
            viewport.scrollTop = 197
            viewport.dispatchEvent(new Event('scroll'))
            listRef.current!.captureHistoryContentAnchor()
        })
        height = 323.5
        view.rerender(<Harness rows={rows.map((row, index) => index === 0 ? { ...row, sourceIds: [...row.sourceIds, 'earlier-history-tool'] } : row)} listRef={listRef} />)
        expect(view.getByTestId('viewport').scrollTop).toBe(384.5)
        expect(row.dataset.hapiRowSize).toBe('323.5')
    })
    it('measures new history rows during native scrolling before ResizeObserver delivery', async () => {
        const view = render(<Harness rows={rows} />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-2')).not.toBeNull())
        const retained = view.container.querySelector('#hapi-message-row-2')
        act(() => {
            const viewport = view.getByTestId('viewport')
            viewport.scrollTop = 300
            viewport.dispatchEvent(new Event('scroll'))
        })
        const older = rows.slice(0, 14).map((row, index) => ({ ...row, id: `older-${index}`, sourceIds: [`older-source-${index}`], createdAt: index - 14 }))
        view.rerender(<Harness rows={[...older, ...rows]} />)
        const newMountedRows = [...view.container.querySelectorAll<HTMLElement>('[data-hapi-virtual-row^="older-"]')]
        expect(newMountedRows.length).toBeGreaterThan(0)
        expect(newMountedRows.every(element => element.dataset.hapiRowSize === '120')).toBe(true)
        expect(view.container.querySelector('#hapi-message-row-2')).toBe(retained)
    })
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

    it('reveals work classified during hydration before navigation completes', async () => {
        const set = vi.fn()
        work.expansion = { set }
        const complete = vi.fn()
        const hydrate = vi.fn(async (_locator: TimelineHistoryLocator) => {
            await new Promise(resolve => setTimeout(resolve, 0))
            view.rerender(<Harness rows={rows.map((row, index) => index === 3 ? { ...row, workTurnId: 'classified-work' } : row)} hydrate={hydrate} />)
            return true
        })
        const view = render(<Harness rows={rows.map((row, index) => index === 3 ? { ...row, resident: false } : row)} hydrate={hydrate} />)
        act(() => { view.getByTestId('viewport').dispatchEvent(new CustomEvent('hapi:ensure-row', { detail: { alias: 'source-3', complete } })) })
        await waitFor(() => expect(complete).toHaveBeenCalledWith(true))
        expect(set).toHaveBeenCalledWith('classified-work', true)
        expect(set.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0])
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

    it('restores the default work choice after temporarily opening a turn for sharing', async () => {
        const expansion = createWorkExpansionState()
        work.expansion = expansion
        const listRef = createRef<VirtualThreadHandle>()
        const view = render(<Harness rows={rows.slice(0, 4).map((row, index) => index === 1 ? { ...row, workTurnId: 'shared-work' } : row)} listRef={listRef} />)
        await waitFor(() => expect(view.container.querySelector('#hapi-message-row-1')).not.toBeNull())
        let release!: () => void
        await act(async () => { release = await listRef.current!.materializeTurn('source-1') })
        expect(expansion.get('shared-work')).toBe(true)
        act(() => release())
        expect(expansion.get('shared-work')).toBeUndefined()
    })
})
