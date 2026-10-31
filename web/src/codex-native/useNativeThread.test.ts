import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useNativeThread } from './useNativeThread'
import type { NativeEvent } from './types'

const entry = (id: string) => ({ turnId: 'turn', item: { id, type: 'agentMessage', text: id }, startedAtMs: 1234 })
const deferredPage = () => {
    let resolve!: (page: { data: ReturnType<typeof entry>[]; nextCursor: string | null }) => void
    const promise = new Promise<{ data: ReturnType<typeof entry>[]; nextCursor: string | null }>(done => { resolve = done })
    return { promise, resolve }
}

describe('native thread window', () => {
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
        expect(api.getCodexNativeItems).toHaveBeenCalledWith('bidirectional', 'opaque-forward-100', 'asc')
        expect(beforeApply).toHaveBeenCalledTimes(1)
        expect(result.current.items.map(value => value.item.id)).toEqual(range(100, 399).map(value => value.item.id))
        expect(result.current.hasNewer).toBe(true)
        await act(async () => { await result.current.newer() })
        expect(result.current.items.map(value => value.item.id)).toEqual(range(101, 400).map(value => value.item.id))
        expect(result.current.hasNewer).toBe(false)
        expect(result.current.cursor).toBe('opaque-reverse-400')
        pages.set('latest', { data: range(352, 401).reverse(), nextCursor: 'older-live', backwardsCursor: 'forward-live' })
        pages.set('opaque-forward-400', { data: range(400, 401), nextCursor: null, backwardsCursor: 'opaque-reverse-400' })
        await act(async () => { await result.current.latest() })
        expect(result.current.hasNewer).toBe(true)
        expect(result.current.items.at(-1)?.item.id).toBe('n-400')
        await act(async () => { await result.current.newer() })
        expect(api.getCodexNativeItems).toHaveBeenLastCalledWith('bidirectional', 'opaque-forward-400', 'asc')
        expect(result.current.items.at(-1)?.item.id).toBe('n-401')
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
                .mockReturnValueOnce(page.promise).mockResolvedValue({ data: [entry('fresh-tail')], nextCursor: 'tail-cursor' }),
            streamCodexNativeEvents: vi.fn(() => new Promise<void>(() => {})),
        }
        const { result, unmount } = renderHook(() => useNativeThread(api as unknown as ApiClient, 'native'))
        await waitFor(() => expect(result.current.loading).toBe(false))
        let seeking!: Promise<boolean>
        act(() => { seeking = result.current.seek('opaque-seek', accepts) })
        act(() => { result.current.cancelOlder() })
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
        expect(api.getCodexNativeItems).toHaveBeenCalledTimes(4)
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
        expect(api.getCodexNativeItems).toHaveBeenLastCalledWith('native', 'opaque-cursor')
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
