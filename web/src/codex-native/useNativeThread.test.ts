import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { projectNativeItems } from './projectNativeItems'
import { useNativeThread } from './useNativeThread'
import type { NativeEvent, NativeItemEntry, NativePage } from './types'

const entry = (id: string) => ({ turnId: 'turn', item: { id, type: 'agentMessage', text: id }, startedAtMs: 1234 })
const deferredPage = () => {
    let resolve!: (page: { data: ReturnType<typeof entry>[]; nextCursor: string | null }) => void
    const promise = new Promise<{ data: ReturnType<typeof entry>[]; nextCursor: string | null }>(done => { resolve = done })
    return { promise, resolve }
}

describe('native thread window', () => {
    it('streams public summary slots without rolling back live text or mutating the history window', async () => {
        let event!: (value: NativeEvent) => void
        let resolvePage!: (page: NativePage<NativeItemEntry>) => void
        let resolveTurn!: (value: unknown) => void
        const initial = new Promise<NativePage<NativeItemEntry>>(done => { resolvePage = done })
        const turn = new Promise(done => { resolveTurn = done })
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'reasoning-stream' } }),
            getCodexNativeActiveTurn: vi.fn().mockReturnValue(turn),
            getCodexNativeItems: vi.fn().mockReturnValue(initial),
            streamCodexNativeEvents: vi.fn((_id: string, _signal: AbortSignal, onEvent: typeof event) => { event = onEvent; return new Promise<void>(() => {}) }),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'reasoning-stream'))
        const params = { threadId: 'reasoning-stream', turnId: 'turn', itemId: 'reasoning' }
        const send = (method: string, value: Record<string, unknown>) => event({ method, params: { ...params, ...value } })
        const summary = () => result.current.items.find(value => value.item.id === 'reasoning')?.item.summary
        act(() => {
            send('turn/started', { turn: { id: 'turn', status: 'inProgress' } })
            send('item/reasoning/summaryPartAdded', { summaryIndex: 0 })
            send('item/reasoning/summaryTextDelta', { summaryIndex: 0, delta: 'First' })
            send('item/reasoning/summaryPartAdded', { summaryIndex: 1 })
            send('item/reasoning/summaryTextDelta', { summaryIndex: 2, delta: 'Third' })
            send('item/reasoning/summaryPartAdded', { summaryIndex: 2 })
            send('item/started', { item: { id: 'reasoning', type: 'reasoning', summary: [] } })
        })
        await act(async () => resolvePage({
            data: [{ turnId: 'turn', item: { id: 'reasoning', type: 'reasoning', summary: ['Fir'] } }],
            nextCursor: 'older',
        }))
        expect(summary()).toEqual(['First', '', 'Third'])
        act(() => {
            send('item/completed', { item: { id: 'reasoning', type: 'reasoning', summary: ['First', '', 'Third done'] } })
            send('turn/completed', { turn: { id: 'turn', status: 'completed' } })
            result.current.browseHistory()
            send('item/reasoning/summaryTextDelta', { itemId: 'new', summaryIndex: 0, delta: 'Newer item' })
        })
        await act(async () => resolveTurn({ activeTurn: { id: 'turn', status: 'inProgress' } }))
        expect(summary()).toEqual(['First', '', 'Third done'])
        expect(result.current.detail.activeTurn).toBeNull()
        expect(result.current.items.map(value => value.item.id)).toEqual(['reasoning'])
        unmount()
    })

    it('keeps confirmed settings when an older detail read finishes late', async () => {
        let resolve!: (value: Record<string, unknown>) => void
        const response = new Promise<Record<string, unknown>>(done => { resolve = done })
        const api = {
            getCodexNativeThread: vi.fn().mockReturnValue(response),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'settings-race'))
        act(() => result.current.applySettings({ model: 'model', effort: 'high' }))
        await act(async () => resolve({ thread: { id: 'settings-race' }, threadSettings: { effort: 'low' } }))
        expect(result.current.detail.threadSettings).toEqual({ model: 'model', effort: 'high' })
        unmount()
    })

    it('retains real live context across history/cache re-entry and clears it on rollback', async () => {
        let event!: (value: NativeEvent) => void
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'context-state' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValue({ data: [entry('context-item')], nextCursor: 'older' }),
            streamCodexNativeEvents: vi.fn((_id: string, _signal: AbortSignal, onEvent: typeof event) => { event = onEvent; return new Promise<void>(() => {}) }),
        }
        const first = renderHook(() => useNativeThread(api as unknown as ApiClient, 'context-state', true, 'context-state-cache'))
        await waitFor(() => expect(first.result.current.loading).toBe(false))
        expect(first.result.current.contextUsage).toBeNull()
        act(() => { event({ method: 'thread/tokenUsage/updated', params: { threadId: 'different-thread', tokenUsage: { last: { totalTokens: 1 }, modelContextWindow: 200000 } } }) })
        expect(first.result.current.contextUsage).toBeNull()
        act(() => { event({ method: 'thread/tokenUsage/updated', params: { threadId: 'context-state', tokenUsage: { last: { inputTokens: 1000, totalTokens: 1200 }, total: { totalTokens: 9_000_000 }, modelContextWindow: 200000 } } }); first.result.current.browseHistory() })
        await act(async () => { await first.result.current.older() })
        expect(first.result.current.contextUsage).toMatchObject({ used: 1200, max: 200000 })
        first.unmount()
        const next = renderHook(() => useNativeThread(api as unknown as ApiClient, 'context-state', true, 'context-state-cache', true))
        expect(next.result.current.contextUsage).toMatchObject({ used: 1200, max: 200000 })
        await waitFor(() => expect(next.result.current.loading).toBe(false))
        act(() => { event({ method: 'thread/rolledBack', params: { threadId: 'context-state' } }); next.unmount() })
        const restored = renderHook(() => useNativeThread(api as unknown as ApiClient, 'context-state', true, 'context-state-cache', true))
        expect(restored.result.current.contextUsage).toBeNull()
        restored.unmount()
    })
    it('keeps an actively read window stable when live items and a newer tail arrive', async () => {
        let event!: (value: NativeEvent) => void
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'reading-live' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('reading')], nextCursor: 'older', backwardsCursor: 'opaque-forward-reading' })
                .mockResolvedValue({ data: [entry('new-tail')], nextCursor: 'other-older', backwardsCursor: 'other-forward' }),
            streamCodexNativeEvents: vi.fn((_id: string, _signal: AbortSignal, onEvent: typeof event) => { event = onEvent; return new Promise<void>(() => {}) }),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'reading-live'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        act(() => { result.current.browseHistory(); event({ method: 'item/completed', params: { item: entry('live-update').item } }) })
        await act(async () => { await result.current.latest() })
        expect(result.current.items.map(value => value.item.id)).toEqual(['reading'])
        expect(result.current.hasNewer).toBe(true)
        expect(result.current.newerCursor).toBe('opaque-forward-reading')
        unmount()
    })

    it('keeps the retained live process current while the reader has stopped following the tail', async () => {
        let event!: (value: NativeEvent) => void
        const recent: NativeItemEntry[] = [
            { turnId: 'turn', item: { id: 'first', type: 'reasoning', summary: ['First heading'] } },
            entry('reading'),
        ]
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'retained-live' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: { id: 'turn', status: 'inProgress' } }),
            getCodexNativeItems: vi.fn().mockResolvedValue({ data: recent, nextCursor: 'opaque-older', backwardsCursor: 'opaque-newer' }),
            streamCodexNativeEvents: vi.fn((_id: string, _signal: AbortSignal, onEvent: typeof event) => { event = onEvent; return new Promise<void>(() => {}) }),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'retained-live'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        const send = (method: string, params: NativeEvent['params']) => event({ method, params: { threadId: 'retained-live', turnId: 'turn', ...params } })
        const reasoning = (turnId?: string) => projectNativeItems(result.current.items, [], true, undefined, turnId)
            .messages.find(message => message.id === 'native:latest:summary:1')?.content
        act(() => {
            result.current.browseHistory()
            send('item/started', { item: { id: 'latest', type: 'reasoning', summary: ['Beginning'] } })
            send('item/reasoning/summaryPartAdded', { itemId: 'latest', summaryIndex: 1 })
            send('item/reasoning/summaryTextDelta', { itemId: 'latest', summaryIndex: 1, delta: 'Live heading' })
            send('item/started', { item: { id: 'command', type: 'commandExecution', command: 'pwd', status: 'inProgress' } })
        })
        expect(result.current.includesLiveTail).toBe(true)
        expect(reasoning('turn')).toMatchObject({
            content: { data: { message: 'Live heading' } }, meta: { nativeReasoningActive: true },
        })
        expect(result.current.items.map(({ item }) => item.id)).toEqual(['reading', 'first', 'latest', 'command'])
        expect(result.current.cursor).toBe('opaque-older')
        expect(result.current.newerCursor).toBe('opaque-newer')

        act(() => {
            send('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'pwd', status: 'completed' } })
            send('turn/completed', { turn: { id: 'turn', status: 'completed' } })
        })
        expect(result.current.detail.activeTurn).toBeNull()
        expect(reasoning()).toMatchObject({ meta: { nativeReasoningActive: false } })
        expect(result.current.items.at(-1)?.item.status).toBe('completed')
        expect(result.current.items[0].item.id).toBe('reading')
        unmount()
    })

    it('scrolls back through evicted newer pages with opaque reverse cursors and a bounded window', async () => {
        const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => entry(`n-${start + i}`))
        const pages = new Map<string, { data: ReturnType<typeof entry>[]; nextCursor: string | null; backwardsCursor: string | null }>()
        pages.set('latest', { data: range(351, 400).reverse(), nextCursor: 'opaque-older-1', backwardsCursor: 'opaque-forward-400' })
        for (let i = 1; i <= 6; i++) {
            const end = 400 - i * 50
            pages.set(`opaque-older-${i}`, { data: range(end - 49, end).reverse(), nextCursor: `opaque-older-${i + 1}`, backwardsCursor: `opaque-forward-${end}` })
        }
        for (let start = 100; start <= 350; start += 50) pages.set(`opaque-forward-${start}`, {
            data: range(start, start + 49), nextCursor: `opaque-forward-${start + 50}`, backwardsCursor: `opaque-reverse-${start}`,
        })
        pages.set('opaque-forward-400', { data: range(400, 400), nextCursor: null, backwardsCursor: 'opaque-reverse-400' })
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'bidirectional' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn(async (_id: string, cursor?: string) => pages.get(cursor ?? 'latest')!),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'bidirectional'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        for (let i = 0; i < 6; i++) await act(async () => { await result.current.older() })
        expect(result.current.items).toHaveLength(300)
        expect(result.current.items[0].item.id).toBe('n-51')
        expect(result.current.items.at(-1)?.item.id).toBe('n-350')
        const beforeApply = vi.fn(() => true)
        await act(async () => { await result.current.newer(beforeApply) })
        expect(api.getCodexNativeItems).toHaveBeenCalledWith('bidirectional', 'opaque-forward-350', 'asc', expect.any(AbortSignal))
        expect(api.getCodexNativeItems.mock.calls.filter(call => call[1] === 'opaque-forward-350')).toHaveLength(1)
        expect(beforeApply).toHaveBeenCalledTimes(1)
        expect(result.current.items.map(value => value.item.id)).toEqual(range(100, 399).map(value => value.item.id))
        expect(result.current.hasNewer).toBe(true)
        await act(async () => { await result.current.newer() })
        expect(result.current.items.map(value => value.item.id)).toEqual(range(101, 400).map(value => value.item.id))
        expect(result.current.hasNewer).toBe(false)
        expect(result.current.cursor).toBe('opaque-older-6')
        pages.set('latest', { data: range(352, 401).reverse(), nextCursor: 'older-live', backwardsCursor: 'forward-live' })
        pages.set('opaque-forward-400', { data: range(400, 401), nextCursor: null, backwardsCursor: 'opaque-reverse-400' })
        await act(async () => { await result.current.latest() })
        expect(result.current.hasNewer).toBe(true)
        expect(result.current.items.at(-1)?.item.id).toBe('n-400')
        await act(async () => { await result.current.newer() })
        expect(api.getCodexNativeItems.mock.calls.filter(call => call[1] === 'opaque-forward-400')).toHaveLength(2)
        expect(result.current.items.at(-1)?.item.id).toBe('n-401')
        unmount()
    })

    it('continues past an invisible history gap after the retained top row leaves the native window', async () => {
        const visible = entry('retained-top')
        const olderVisible = entry('older-visible')
        const page = (index: number): NativePage<NativeItemEntry> => ({
            data: Array.from({ length: 50 }, (_, offset) => ({
                turnId: 'turn', item: { id: `hidden-${index}-${offset}`, type: 'reasoning', summary: [] },
            })),
            nextCursor: index === 7 ? 'older-visible' : `older-${index + 1}`,
        })
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'invisible-gap' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn(async (_id: string, cursor?: string) => {
                if (!cursor) return { data: [visible], nextCursor: 'older-1' }
                if (cursor === 'older-visible') return { data: [olderVisible], nextCursor: null }
                return page(Number(cursor.slice('older-'.length)))
            }),
            getCodexNativeTurnContext: vi.fn().mockResolvedValue({ data: [visible], nextCursor: 'older-1', backwardsCursor: null }),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'invisible-gap'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        for (let index = 1; index <= 6; index++) {
            await act(async () => { expect(await result.current.older()).not.toBeNull() })
        }
        expect(result.current.items).toHaveLength(300)
        expect(result.current.items.some(({ item }) => item.id === visible.item.id)).toBe(false)
        expect(projectNativeItems(result.current.items, []).messages).toEqual([])
        expect(result.current.cursor).toBe('older-7')
        expect(result.current.historyDirection).toBe('older')
        expect(result.current.canContinueHistoryEdge('older')).toBe(true)
        expect(result.current.canContinueHistoryEdge('newer')).toBe(false)
        await act(async () => { await result.current.older() })
        expect(result.current.cursor).toBe('older-visible')
        expect(result.current.canContinueHistoryEdge('older')).toBe(true)
        await act(async () => { await result.current.older() })
        expect(result.current.items[0]?.item.id).toBe(olderVisible.item.id)
        expect(result.current.historyDirection).toBe('older')
        expect(api.getCodexNativeTurnContext).not.toHaveBeenCalled()

        await act(async () => { await result.current.seekTurn('turn', visible.item.id, () => true) })
        expect(result.current.cursor).toBe('older-1')
        expect(result.current.historyDirection).toBeUndefined()
        expect(result.current.canContinueHistoryEdge('older')).toBe(false)
        unmount()
    })

    it('shares a slow prefetched page with boundary demand without publishing it early', async () => {
        const page = deferredPage()
        const nextPage = deferredPage()
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'prefetch-native' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('current')], nextCursor: 'opaque-neighbor' })
                .mockReturnValueOnce(page.promise).mockReturnValue(nextPage.promise),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'prefetch-native'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        let speculative!: Promise<void>
        act(() => { speculative = result.current.prefetch('older') })
        expect(result.current.items.map(value => value.item.id)).toEqual(['current'])
        expect(result.current.olderLoading).toBe(false)
        let demand!: ReturnType<typeof result.current.older>
        act(() => { demand = result.current.older() })
        await act(async () => {
            page.resolve({ data: [entry('neighbor')], nextCursor: 'opaque-next-neighbor' })
            await speculative
            expect(await demand).not.toBeNull()
        })
        expect(api.getCodexNativeItems).toHaveBeenCalledTimes(3)
        expect(api.getCodexNativeItems).toHaveBeenLastCalledWith('prefetch-native', 'opaque-next-neighbor', 'desc', expect.any(AbortSignal))
        expect(result.current.items.map(value => value.item.id)).toEqual(['neighbor', 'current'])
        await act(async () => {
            const next = result.current.older()
            nextPage.resolve({ data: [entry('next-neighbor')], nextCursor: null })
            expect(await next).not.toBeNull()
        })
        expect(api.getCodexNativeItems).toHaveBeenCalledTimes(3)
        expect(result.current.items.map(value => value.item.id)).toEqual(['next-neighbor', 'neighbor', 'current'])
        unmount()
    })

    it('seeds a turn target with a full-thread context window and continues in both global directions', async () => {
        const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => entry(`n-${start + i}`))
        const context = {
            data: range(301, 400).reverse(),
            nextCursor: 'opaque-before-301',
            backwardsCursor: null,
            newerResumeCursor: 'opaque-after-350',
        }
        let liveTail = 400
        const older = new Map<string, NativePage<ReturnType<typeof entry>>>(Array.from({ length: 8 }, (_, index) => {
            const first = 51 + index * 50
            return [`opaque-before-${first}`, {
                data: range(first - 50, first - 1).reverse(),
                nextCursor: first > 51 ? `opaque-before-${first - 50}` : null,
                backwardsCursor: `opaque-after-${first - 1}`,
            }] as const
        }))
        const newer = new Map<string, () => NativePage<ReturnType<typeof entry>>>(Array.from({ length: 9 }, (_, index) => {
            const after = 50 + index * 50
            return [`opaque-after-${after}`, () => ({
                data: range(after + 1, Math.min(after + 50, liveTail)),
                nextCursor: after + 50 < liveTail ? `opaque-after-${after + 50}` : null,
                backwardsCursor: `opaque-before-${after + 1}`,
            })] as const
        }))
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'turn-jump' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeTurnContext: vi.fn().mockResolvedValue(context),
            getCodexNativeItems: vi.fn(async (_id: string, cursor?: string, direction = 'desc') => {
                if (cursor === undefined) return { data: range(liveTail - 49, liveTail).reverse(), nextCursor: `opaque-before-${liveTail - 49}`, backwardsCursor: `opaque-after-${liveTail}` }
                const page = direction === 'asc' ? newer.get(cursor)?.() : older.get(cursor)
                if (!page) throw new Error(`Unexpected history cursor ${cursor}`)
                return page
            }),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'turn-jump'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        await act(async () => {
            expect(await result.current.seekTurn('selected-turn', 'n-350', entries => entries.some(value => value.item.id === 'n-350'))).toBe(true)
        })
        expect(api.getCodexNativeTurnContext).toHaveBeenCalledWith('turn-jump', 'selected-turn', 'n-350', expect.any(AbortSignal))
        expect(result.current.items.map(value => value.item.id)).toEqual(range(301, 400).map(value => value.item.id))
        expect(result.current.cursor).toBe('opaque-before-301')
        expect(result.current.newerCursor).toBe('opaque-after-350')
        expect(result.current.hasNewer).toBe(false)
        liveTail = 450
        await act(async () => { await result.current.latest() })
        expect(result.current.hasNewer).toBe(true)
        for (let page = 0; page < 5; page++) {
            await act(async () => { await result.current.older() })
        }
        expect(result.current.items.map(value => value.item.id)).toEqual(range(51, 350).map(value => value.item.id))
        await act(async () => { await result.current.newer() })
        await act(async () => { await result.current.newer() })
        expect(result.current.items.map(value => value.item.id)).toEqual(range(151, 450).map(value => value.item.id))
        await act(async () => { await result.current.older() })
        await act(async () => { await result.current.newer() })
        expect(result.current.items.map(value => value.item.id)).toEqual(range(151, 450).map(value => value.item.id))
        expect(api.getCodexNativeItems).toHaveBeenCalledWith('turn-jump', 'opaque-before-301', 'desc', expect.any(AbortSignal))
        expect(api.getCodexNativeItems).toHaveBeenCalledWith('turn-jump', 'opaque-after-350', 'asc', expect.any(AbortSignal))
        expect(api.getCodexNativeItems.mock.calls.filter(call => call[1] === undefined)).toHaveLength(2)
        unmount()
    })

    it('keeps forward reading available when a shared end-page request predates a live update', async () => {
        const page = deferredPage()
        let event!: (value: NativeEvent) => void
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'moving-end' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('current')], nextCursor: null, backwardsCursor: 'opaque-after-current' })
                .mockReturnValueOnce(page.promise).mockResolvedValue({ data: [entry('arrived')], nextCursor: null }),
            streamCodexNativeEvents: vi.fn((_id: string, _signal: AbortSignal, onEvent: typeof event) => { event = onEvent; return new Promise<void>(() => {}) }),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'moving-end'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        let warm!: Promise<void>
        let demand!: ReturnType<typeof result.current.newer>
        act(() => { warm = result.current.prefetch('newer'); demand = result.current.newer() })
        act(() => event({ method: 'item/completed', params: { item: entry('arrived').item } }))
        await act(async () => {
            page.resolve({ data: [], nextCursor: null })
            await warm
            expect((await demand)?.hasMore).toBe(true)
        })
        expect(result.current.hasNewer).toBe(true)
        await act(async () => {
            expect((await result.current.newer())?.hasMore).toBe(false)
            event({ method: 'turn/started', params: { threadId: 'moving-end', turn: { id: 'turn', status: 'inProgress' } } })
            event({ method: 'item/started', params: { threadId: 'moving-end', turnId: 'turn', item: entry('live-after-page').item } })
        })
        expect(result.current.items.slice(-2).map(({ item }) => item.id)).toEqual(['arrived', 'live-after-page'])
        expect(result.current.historyDirection).toBe('newer')
        expect(result.current.hasNewer).toBe(false)
        unmount()
    })

    it('keeps a bounded reading window across file-preview remounts and can still return to latest', async () => {
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'cached-native' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('tail')], nextCursor: 'opaque-older' })
                .mockResolvedValueOnce({ data: [entry('reading')], nextCursor: 'opaque-before-reading' })
                .mockResolvedValue({ data: [entry('new-tail')], nextCursor: 'new-cursor' }),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const first = renderHook(() => useNativeThread(api as unknown as ApiClient, 'cached-native', true, 'native-cache-test'))
        await waitFor(() => expect(first.result.current.items).toHaveLength(1))
        await act(async () => { await first.result.current.older() })
        first.unmount()
        const second = renderHook(() => useNativeThread(api as unknown as ApiClient, 'cached-native', true, 'native-cache-test', true))
        await waitFor(() => expect(second.result.current.loading).toBe(false))
        expect(second.result.current.items.map(value => value.item.id)).toEqual(['reading', 'tail'])
        expect(second.result.current.cursor).toBe('opaque-before-reading')
        await act(async () => { await second.result.current.latest(true) })
        expect(second.result.current.items.map(value => value.item.id)).toEqual(['new-tail'])
        second.unmount()
    })

    it('prevents an obsolete seek from replacing a newer Return latest request', async () => {
        const page = deferredPage()
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'native' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('initial')], nextCursor: 'older' })
                .mockReturnValueOnce(page.promise).mockResolvedValue({ data: [entry('latest')], nextCursor: null }),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'native'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        let seeking!: Promise<boolean>
        act(() => { seeking = result.current.seek('opaque-seek', () => true) })
        await act(async () => { await result.current.latest(true) })
        await act(async () => { page.resolve({ data: [entry('obsolete')], nextCursor: 'obsolete' }); expect(await seeking).toBe(false) })
        expect(result.current.items.map(value => value.item.id)).toEqual(['latest'])
        unmount()
    })

    it('keeps the current window when closing the outline cancels a pending seek', async () => {
        const page = deferredPage()
        const accepts = vi.fn(() => true)
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'native' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('reading')], nextCursor: 'current-cursor' })
                .mockResolvedValue({ data: [entry('fresh-tail')], nextCursor: 'tail-cursor' }),
            getCodexNativeTurnContext: vi.fn().mockReturnValue(page.promise),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'native'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        let seeking!: Promise<boolean>
        act(() => { seeking = result.current.seekTurn('selected-turn', 'selected-item', accepts) })
        const signal = api.getCodexNativeTurnContext.mock.calls[0][3] as AbortSignal
        act(() => { result.current.cancelOlder() })
        expect(signal.aborted).toBe(true)
        expect(result.current.olderLoading).toBe(false)
        await act(async () => { page.resolve({ data: [entry('cancelled')], nextCursor: 'cancelled-cursor' }); expect(await seeking).toBe(false) })
        expect(accepts).not.toHaveBeenCalled()
        expect(result.current.items.map(value => value.item.id)).toEqual(['reading'])
        expect(result.current.cursor).toBe('current-cursor')
        await act(async () => { await result.current.latest() })
        expect(result.current.items.map(value => value.item.id)).toEqual(['fresh-tail'])
        expect(result.current.loading).toBe(false)
        unmount()
    })
    it('discards an older page that finishes after Return latest replaces the window', async () => {
        const olderPage = deferredPage()
        const latestPage = deferredPage()
        const beforeApply = vi.fn(() => true)
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'native' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('initial')], nextCursor: 'older-cursor' })
                .mockReturnValueOnce(olderPage.promise).mockReturnValueOnce(latestPage.promise),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'native'))
        await waitFor(() => expect(result.current.cursor).toBe('older-cursor'))
        let pendingOlder!: ReturnType<typeof result.current.older>
        act(() => { pendingOlder = result.current.older(beforeApply) })
        expect(result.current.olderLoading).toBe(true)
        let pendingLatest!: Promise<void>
        act(() => { pendingLatest = result.current.latest(true) })
        expect(result.current.olderLoading).toBe(false)
        await act(async () => { latestPage.resolve({ data: [entry('latest')], nextCursor: 'latest-cursor' }); await pendingLatest })
        await act(async () => { olderPage.resolve({ data: [entry('stale-older')], nextCursor: 'stale-cursor' }); expect(await pendingOlder).toBeNull() })
        expect(result.current.items.map(value => value.item.id)).toEqual(['latest'])
        expect(result.current.cursor).toBe('latest-cursor')
        expect(result.current.hasNewer).toBe(false)
        expect(result.current.olderLoading).toBe(false)
        expect(beforeApply).not.toHaveBeenCalled()
        unmount()
    })

    it('lets Return latest supersede an in-flight background refresh while browsing history', async () => {
        const backgroundPage = deferredPage()
        const resetPage = deferredPage()
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'native' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('initial')], nextCursor: 'older-cursor' })
                .mockResolvedValueOnce({ data: [entry('older')], nextCursor: 'history-cursor' })
                .mockResolvedValueOnce({ data: [entry('warmed')], nextCursor: null })
                .mockReturnValueOnce(backgroundPage.promise).mockReturnValueOnce(resetPage.promise),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'native'))
        await waitFor(() => expect(result.current.cursor).toBe('older-cursor'))
        await act(async () => { await result.current.older() })
        let background!: Promise<void>
        let reset!: Promise<void>
        act(() => { background = result.current.latest() })
        act(() => { reset = result.current.latest(true) })
        expect(api.getCodexNativeItems).toHaveBeenCalledTimes(5)
        expect(api.getCodexNativeItems).toHaveBeenNthCalledWith(3, 'native', 'history-cursor', 'desc', expect.any(AbortSignal))
        await act(async () => { resetPage.resolve({ data: [entry('reset-tail')], nextCursor: 'reset-cursor' }); await reset })
        await act(async () => { backgroundPage.resolve({ data: [entry('stale-background')], nextCursor: 'stale-cursor' }); await background })
        expect(result.current.items.map(value => value.item.id)).toEqual(['reset-tail'])
        expect(result.current.cursor).toBe('reset-cursor')
        expect(result.current.hasNewer).toBe(false)
        expect(result.current.loading).toBe(false)
        unmount()
    })

    it('loads metadata independently, follows opaque older cursors, and releases the selected subscription', async () => {
        let resolveItems!: (value: unknown) => void
        const signal: AbortSignal[] = []
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'native', status: { type: 'idle' } } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveItems = resolve }))
                .mockResolvedValueOnce({ data: [entry('older')], nextCursor: null }),
            streamCodexNativeEvents: vi.fn((_id: string, abort: AbortSignal) => { signal.push(abort); return new Promise<void>(() => {}) }),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'native'))
        await waitFor(() => expect(result.current.detail.thread).toBeDefined())
        expect(result.current.loading).toBe(true)
        await act(async () => resolveItems({ data: [entry('latest')], nextCursor: 'opaque-cursor' }))
        await act(async () => { await result.current.older() })
        expect(api.getCodexNativeItems).toHaveBeenLastCalledWith('native', 'opaque-cursor', 'desc', expect.any(AbortSignal))
        expect(result.current.items.map(value => value.item.id)).toEqual(['older', 'latest'])
        unmount()
        expect(signal[0].aborted).toBe(true)
    })

    it('resets latest items and cursor together after reconnect instead of bridging a missing range', async () => {
        let event!: (value: NativeEvent) => void
        const api = {
            getCodexNativeThread: vi.fn().mockResolvedValue({ thread: { id: 'native' } }),
            getCodexNativeActiveTurn: vi.fn().mockResolvedValue({ activeTurn: null }),
            getCodexNativeItems: vi.fn().mockResolvedValueOnce({ data: [entry('old-tail')], nextCursor: 'old-cursor' })
                .mockResolvedValue({ data: [entry('new-tail')], nextCursor: 'new-cursor' }),
            streamCodexNativeEvents: vi.fn((_id: string, _signal: AbortSignal, onEvent: typeof event) => { event = onEvent; return new Promise<void>(() => {}) }),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'native'))
        await waitFor(() => expect(result.current.items).toHaveLength(1))
        act(() => event({ method: 'hapi/ready', params: { requests: [] } }))
        await waitFor(() => expect(result.current.cursor).toBe('new-cursor'), { timeout: 2000 })
        expect(result.current.items.map(value => value.item.id)).toEqual(['new-tail'])
        unmount()
    })
})
