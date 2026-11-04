import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { useConversationHistoryIndex } from './useConversationHistoryIndex'
import type { ConversationOutlineItem } from '@/chat/outline'

const user = (id: string, text: string, at = 1000) => ({ item: { id, type: 'userMessage', content: [{ type: 'text', text }] }, startedAtMs: at })
const session = (id: string) => ({ id, metadata: { nativeCodex: { endpointId: 'endpoint', threadId: id } } }) as Session
const empty: ConversationOutlineItem[] = []
const outline = (id: string): ConversationOutlineItem => ({ id: `outline:user-text:native:${id}`, targetMessageId: `user-text:native:${id}`, kind: 'user', label: id, createdAt: 1000 })

describe('conversation prompt history index', () => {
    it('indexes earlier prompts separately and locates their page through its unchanged opaque cursor', async () => {
        const cursor = 'opaque / ? + = older'
        const getCodexNativeItems = vi.fn()
            .mockResolvedValueOnce({ data: [user('new', 'Current prompt')], nextCursor: cursor })
            .mockResolvedValueOnce({ data: [user('old', 'Earlier searchable prompt', 100)], nextCursor: null })
        const locate = vi.fn().mockResolvedValue(true)
        const nativeSession = session('outline-pagination')
        const { result, unmount } = renderHook(() => useConversationHistoryIndex({
            api: { getCodexNativeItems } as unknown as ApiClient,
            session: nativeSession, open: true, currentItems: empty, messagesVersion: 0, onLocateNativePage: locate,
        }))
        await waitFor(() => expect(result.current.items).toHaveLength(1))
        expect(result.current.hasEarlier).toBe(true)
        await act(async () => { await result.current.loadEarlier() })
        expect(getCodexNativeItems).toHaveBeenLastCalledWith(nativeSession.id, cursor)
        expect(result.current.items.map(item => item.label)).toEqual(['Earlier searchable prompt', 'Current prompt'])
        expect(result.current.hasEarlier).toBe(false)
        await act(async () => { expect(await result.current.locate(result.current.items[0])).toBe(true) })
        expect(locate).toHaveBeenCalledWith(cursor, 'user-text:native:old')
        unmount()
    })

    it('does not scan an unbounded history when a page contains no user prompt', async () => {
        let page = 0
        const getCodexNativeItems = vi.fn(async () => ({ data: [], nextCursor: `opaque-older-${++page}` }))
        const nativeSession = session('outline-empty-page')
        const { result, unmount } = renderHook(() => useConversationHistoryIndex({
            api: { getCodexNativeItems } as unknown as ApiClient,
            session: nativeSession, open: true, currentItems: empty, messagesVersion: 0,
        }))
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(getCodexNativeItems).toHaveBeenCalledTimes(8)
        expect(result.current.scannedPages).toBe(8)
        expect(result.current.hasEarlier).toBe(true)
        unmount()
    })

    it('keeps loading across empty tool pages and a live invalidation until the refreshed index commits', async () => {
        let resolveStale!: (page: unknown) => void
        let resolveFresh!: (page: unknown) => void
        const getCodexNativeItems = vi.fn()
            .mockReturnValueOnce(new Promise(resolve => { resolveStale = resolve }))
            .mockReturnValueOnce(new Promise(resolve => { resolveFresh = resolve }))
            .mockResolvedValueOnce({ data: [user('earlier', 'Earlier prompt')], nextCursor: null })
        const nativeSession = session('outline-loading-rebase')
        const api = { getCodexNativeItems } as unknown as ApiClient
        const { result, rerender, unmount } = renderHook(({ items, version }) => useConversationHistoryIndex({
            api, session: nativeSession, open: true, currentItems: items, messagesVersion: version,
        }), { initialProps: { items: empty, version: 0 } })
        await waitFor(() => expect(result.current.loading).toBe(true))
        rerender({ items: [outline('live')], version: 1 })
        expect(result.current.loading).toBe(true)
        await act(async () => { resolveStale({ data: [], nextCursor: 'obsolete-cursor' }) })
        expect(result.current.loading).toBe(true)
        expect(getCodexNativeItems).toHaveBeenNthCalledWith(2, nativeSession.id, undefined)
        await act(async () => { resolveFresh({ data: [], nextCursor: 'opaque-tools-before-prompt' }) })
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.items.map(item => item.label)).toContain('Earlier prompt')
        expect(getCodexNativeItems).toHaveBeenLastCalledWith(nativeSession.id, 'opaque-tools-before-prompt')
        unmount()
    })

    it('retains new prompt previews after window eviction and invalidates a completed index', async () => {
        const nativeSession = session('outline-live-tail')
        const api = { getCodexNativeItems: vi.fn().mockResolvedValue({ data: [user('first', 'first')], nextCursor: null }) } as unknown as ApiClient
        const { result, rerender, unmount } = renderHook(({ items, version }) => useConversationHistoryIndex({
            api, session: nativeSession, open: true, currentItems: items, messagesVersion: version, viewMode: 'tail',
        }), { initialProps: { items: [outline('first')], version: 0 } })
        await waitFor(() => expect(result.current.hasEarlier).toBe(false))
        rerender({ items: [outline('first'), outline('middle'), outline('latest')], version: 1 })
        expect(result.current.hasEarlier).toBe(true)
        rerender({ items: [outline('latest')], version: 2 })
        expect(result.current.items.map(item => item.label)).toContain('middle')
        expect(result.current.items.find(item => item.label === 'first')?.historyPage).toBeUndefined()
        unmount()
    })

    it('repairs a drifting latest-page locator through a bounded scan and its real opaque cursor', async () => {
        const nativeSession = session('outline-drifting-head')
        const getCodexNativeItems = vi.fn()
            .mockResolvedValueOnce({ data: [user('target', 'Target prompt')], nextCursor: null })
            .mockResolvedValueOnce({ data: [user('new', 'New prompt')], nextCursor: 'opaque-real-older' })
            .mockResolvedValueOnce({ data: [user('target', 'Target prompt')], nextCursor: null })
        const locate = vi.fn().mockResolvedValue(true)
        const api = { getCodexNativeItems } as unknown as ApiClient
        const { result, rerender, unmount } = renderHook(({ version }) => useConversationHistoryIndex({
            api, session: nativeSession, open: true, currentItems: empty, messagesVersion: version, onLocateNativePage: locate,
        }), { initialProps: { version: 0 } })
        await waitFor(() => expect(result.current.items).toHaveLength(1))
        rerender({ version: 1 })
        expect(result.current.items[0].historyPage).toBeUndefined()
        await act(async () => { expect(await result.current.locate(result.current.items[0])).toBe(true) })
        expect(locate).toHaveBeenCalledTimes(1)
        expect(locate).toHaveBeenCalledWith('opaque-real-older', 'user-text:native:target')
        expect(getCodexNativeItems).toHaveBeenCalledTimes(3)
        unmount()
    })

    it('expires a completed index while the conversation stays mounted', async () => {
        vi.useFakeTimers()
        const nativeSession = session('outline-active-ttl')
        const api = { getCodexNativeItems: vi.fn().mockResolvedValue({ data: [user('first', 'first')], nextCursor: null }) } as unknown as ApiClient
        const { result, unmount } = renderHook(() => useConversationHistoryIndex({
            api, session: nativeSession, open: true, currentItems: empty, messagesVersion: 0,
        }))
        try {
            await act(async () => { await Promise.resolve() })
            expect(result.current.hasEarlier).toBe(false)
            act(() => { vi.advanceTimersByTime(5 * 60 * 1000 + 1) })
            expect(result.current.hasEarlier).toBe(true)
        } finally { vi.useRealTimers(); unmount() }
    })

    it('keeps its cache and error state when a newer navigation supersedes a locate', async () => {
        let resolve!: (value: boolean) => void
        const pending = new Promise<boolean>(done => { resolve = done })
        const nativeSession = session('outline-cancelled-locate')
        const { result, unmount } = renderHook(() => useConversationHistoryIndex({
            api: { getCodexNativeItems: vi.fn().mockResolvedValue({ data: [user('one', 'Indexed prompt')], nextCursor: null }) } as unknown as ApiClient,
            session: nativeSession, open: true, currentItems: empty, messagesVersion: 0,
            onLocateNativePage: () => pending,
        }))
        await waitFor(() => expect(result.current.items).toHaveLength(1))
        let locating!: Promise<boolean>
        act(() => { locating = result.current.locate(result.current.items[0], () => false) })
        await act(async () => { resolve(false); expect(await locating).toBe(false) })
        expect(result.current.items).toHaveLength(1)
        expect(result.current.error).toBeNull()
        unmount()
    })
})
