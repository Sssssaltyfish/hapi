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
