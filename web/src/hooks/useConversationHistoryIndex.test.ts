import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { ConversationOutlineItem, ConversationOutlinePage } from '@/chat/outline'
import { useConversationHistoryIndex } from './useConversationHistoryIndex'

const empty: ConversationOutlineItem[] = []
const session = (id: string) => ({ id, metadata: { nativeCodex: { endpointId: 'endpoint', threadId: id } } }) as Session
const item = (id: string, at = 100, cursor: string | null = null): ConversationOutlineItem => ({
    id: `outline:user-text:native:${id}`, targetMessageId: `user-text:native:${id}`, kind: 'user', label: id, createdAt: at,
    indexPage: { kind: 'native-turns', cursor }, nativeTurn: { turnId: `turn-${id}`, itemId: id },
})
const page = (items: ConversationOutlineItem[], cursor: string | null = null, overlapId?: string): ConversationOutlinePage => ({
    items, next: cursor ? { kind: 'native-turns', cursor } : null, scanned: 1, epoch: null, reachedHead: Boolean(overlapId), overlapId,
})

beforeEach(() => { vi.stubGlobal('indexedDB', undefined) })

describe('continuous prompt outline', () => {
    it('continues automatically past newly found prompts and empty tool pages without a 1000-row truncation', async () => {
        const getConversationOutline = vi.fn()
            .mockResolvedValueOnce(page([item('new', 2000)], 'opaque-1'))
            .mockResolvedValueOnce(page([], 'opaque-2'))
            .mockResolvedValueOnce(page(Array.from({ length: 1200 }, (_, n) => item(`old-${n}`, n, 'opaque-2'))))
        const api = { getConversationOutline } as unknown as ApiClient
        const visibleSteer = [item('visible-steering-input')]
        const { result, unmount } = renderHook(() => useConversationHistoryIndex({ api, session: session('continuous'), open: true, currentItems: visibleSteer, messagesVersion: 0 }))
        await waitFor(() => expect(result.current.items).toHaveLength(1201))
        expect(result.current.hasEarlier).toBe(false)
        expect(result.current.capped).toBe(false)
        expect(result.current.items.some(value => value.label === 'visible-steering-input')).toBe(false)
        expect(getConversationOutline.mock.calls.map(call => call[1])).toEqual([
            { kind: 'native-turns', cursor: null }, { kind: 'native-turns', cursor: 'opaque-1' }, { kind: 'native-turns', cursor: 'opaque-2' },
        ])
        unmount()
    })

    it('shows a warm index immediately and checks only the head against cached user boundaries', async () => {
        const getConversationOutline = vi.fn().mockResolvedValueOnce(page([item('A1', 1), item('A2', 2)]))
            .mockResolvedValueOnce(page([item('A3', 3), item('A2', 2)], null, 'user-text:native:A2'))
        const api = { getConversationOutline } as unknown as ApiClient
        const s = session('warm-head')
        const options = { api, session: s, open: true, currentItems: empty, messagesVersion: 0 }
        const first = renderHook(() => useConversationHistoryIndex(options))
        await waitFor(() => expect(first.result.current.items).toHaveLength(2))
        await waitFor(() => expect(first.result.current.loading).toBe(false))
        first.unmount()
        const second = renderHook(() => useConversationHistoryIndex(options))
        expect(second.result.current.items).toHaveLength(2)
        await waitFor(() => expect(second.result.current.items).toHaveLength(3))
        expect(getConversationOutline).toHaveBeenLastCalledWith(s.id, { kind: 'native-turns', cursor: null }, ['user-text:native:A2', 'user-text:native:A1'])
        second.unmount()
    })

    it('reconciles an offline rewind from A5 to A3 without leaving deleted cached prompts or opaque locators', async () => {
        const original = [1, 2, 3, 4, 5].map(n => item(`A${n}`, n, 'old-opaque'))
        const survivors = [3, 2, 1].map(n => item(`A${n}`, n))
        const getConversationOutline = vi.fn().mockResolvedValueOnce(page(original))
            .mockResolvedValueOnce(page([item('A3', 3)], null, 'user-text:native:A3'))
            .mockResolvedValueOnce(page(survivors))
        const api = { getConversationOutline } as unknown as ApiClient
        const options = { api, session: session('offline-rewind'), open: true, currentItems: empty, messagesVersion: 0 }
        const first = renderHook(() => useConversationHistoryIndex(options))
        await waitFor(() => expect(first.result.current.items).toHaveLength(5))
        first.unmount()
        const second = renderHook(() => useConversationHistoryIndex(options))
        await waitFor(() => expect(second.result.current.items.map(value => value.label)).toEqual(['A1', 'A2', 'A3']))
        await waitFor(() => expect(second.result.current.loading).toBe(false))
        expect(second.result.current.items.every(value => value.indexPage?.kind === 'native-turns' && value.indexPage.cursor === null)).toBe(true)
        expect(second.result.current.hasEarlier).toBe(false)
        second.unmount()
    })

    it('discards an in-flight old generation and rebuilds after an online rollback', async () => {
        let resolve!: (value: ConversationOutlinePage) => void
        const getConversationOutline = vi.fn().mockReturnValueOnce(new Promise(done => { resolve = done }))
            .mockResolvedValueOnce(page([item('survivor')]))
        const api = { getConversationOutline } as unknown as ApiClient
        const s = session('online-reset')
        const { result, rerender, unmount } = renderHook(({ revision }) => useConversationHistoryIndex({
            api, session: s, open: true, currentItems: empty, messagesVersion: 0, conversationHistoryRevision: revision,
        }), { initialProps: { revision: 0 } })
        await waitFor(() => expect(getConversationOutline).toHaveBeenCalledTimes(1))
        rerender({ revision: 1 })
        await act(async () => { resolve(page([item('obsolete')], 'invalid-old')) })
        await waitFor(() => expect(result.current.items.map(value => value.label)).toEqual(['survivor']))
        expect(result.current.hasEarlier).toBe(false)
        unmount()
    })

    it('keeps progress on failure and retries the same continuation instead of restarting history', async () => {
        const getConversationOutline = vi.fn().mockResolvedValueOnce(page([item('head')], 'resume-here'))
            .mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValueOnce(page([item('older', 1, 'resume-here')]))
        const api = { getConversationOutline } as unknown as ApiClient
        const { result, unmount } = renderHook(() => useConversationHistoryIndex({ api, session: session('retry'), open: true, currentItems: empty, messagesVersion: 0 }))
        await waitFor(() => expect(result.current.error).toContain('temporarily unavailable'))
        expect(result.current.items.map(value => value.label)).toEqual(['head'])
        expect(result.current.hasEarlier).toBe(true)
        await act(async () => { await result.current.loadEarlier() })
        expect(getConversationOutline).toHaveBeenLastCalledWith('retry', { kind: 'native-turns', cursor: 'resume-here' }, undefined)
        expect(result.current.items.map(value => value.label)).toEqual(['older', 'head'])
        unmount()
    })

    it('locates a summary user directly without treating the turn-page cursor as a body cursor', async () => {
        const getConversationOutline = vi.fn().mockResolvedValueOnce(page([item('target')]))
        const locate = vi.fn().mockResolvedValueOnce(true)
        const api = { getConversationOutline } as unknown as ApiClient
        const { result, unmount } = renderHook(() => useConversationHistoryIndex({ api, session: session('locate'), open: true, currentItems: empty, messagesVersion: 0, onLocateNativeTurn: locate }))
        await waitFor(() => expect(result.current.items).toHaveLength(1))
        await act(async () => { expect(await result.current.locate(result.current.items[0])).toBe(true) })
        expect(locate).toHaveBeenLastCalledWith('turn-target', 'target', 'user-text:native:target', expect.any(Function))
        expect(getConversationOutline).toHaveBeenCalledTimes(1)
        unmount()
    })

    it('rebuilds an invalid cursor once, then waits for an explicit retry without dropping previews', async () => {
        const getConversationOutline = vi.fn().mockResolvedValueOnce(page([item('retained')], 'bad-cursor'))
            .mockRejectedValueOnce(new Error('Invalid native cursor'))
            .mockResolvedValueOnce(page([item('retained')], 'bad-cursor'))
            .mockRejectedValueOnce(new Error('Invalid native cursor'))
            .mockResolvedValueOnce(page([item('retained')]))
        const api = { getConversationOutline } as unknown as ApiClient
        const s = session('bounded-cursor-recovery')
        const { result, rerender, unmount } = renderHook(({ version }) => useConversationHistoryIndex({
            api, session: s, open: true, currentItems: empty, messagesVersion: version,
        }), { initialProps: { version: 0 } })
        await waitFor(() => expect(result.current.error).toContain('Invalid native cursor'))
        expect(getConversationOutline).toHaveBeenCalledTimes(4)
        expect(result.current.items.map(value => value.label)).toEqual(['retained'])
        rerender({ version: 1 })
        expect(getConversationOutline).toHaveBeenCalledTimes(4)
        await act(async () => { await result.current.loadEarlier() })
        expect(getConversationOutline).toHaveBeenCalledTimes(5)
        expect(result.current.error).toBeNull()
        expect(result.current.hasEarlier).toBe(false)
        unmount()
    })

    it('takes over a partial warm index after its previous mounted view abandons an in-flight page', async () => {
        let resolve!: (value: ConversationOutlinePage) => void
        const getConversationOutline = vi.fn().mockResolvedValueOnce(page([item('head', 200)], 'older-page'))
            .mockReturnValueOnce(new Promise(done => { resolve = done }))
            .mockResolvedValueOnce(page([item('head', 200)], null, 'user-text:native:head'))
            .mockResolvedValueOnce(page([item('older', 100, 'older-page')]))
        const api = { getConversationOutline } as unknown as ApiClient
        const options = { api, session: session('remount-pending'), open: true, currentItems: empty, messagesVersion: 0 }
        const first = renderHook(() => useConversationHistoryIndex(options))
        await waitFor(() => expect(getConversationOutline).toHaveBeenCalledTimes(2))
        first.unmount()
        const second = renderHook(() => useConversationHistoryIndex(options))
        expect(second.result.current.items.map(value => value.label)).toEqual(['head'])
        await act(async () => { resolve(page([item('abandoned', 50)], 'obsolete-next')) })
        await waitFor(() => expect(second.result.current.items.map(value => value.label)).toEqual(['older', 'head']))
        expect(getConversationOutline).toHaveBeenLastCalledWith('remount-pending', { kind: 'native-turns', cursor: 'older-page' }, undefined)
        expect(second.result.current.hasEarlier).toBe(false)
        second.unmount()
    })

    it('does not restart an open head scan when a Native API wrapper changes for the same authenticated scope', async () => {
        const getConversationOutline = vi.fn().mockResolvedValue(page([item('stable')]))
        const wrapper = () => ({
            getConversationOutline,
            getConversationCacheScope: () => ({ key: 'stable-wrapper-scope', persistent: false }),
        }) as unknown as ApiClient
        const s = session('wrapper-churn')
        const { result, rerender, unmount } = renderHook(({ api }) => useConversationHistoryIndex({
            api, session: s, open: true, currentItems: empty, messagesVersion: 0,
        }), { initialProps: { api: wrapper() } })
        await waitFor(() => expect(result.current.items).toHaveLength(1))
        await waitFor(() => expect(result.current.loading).toBe(false))
        await act(async () => { rerender({ api: wrapper() }); await Promise.resolve() })
        expect(getConversationOutline).toHaveBeenCalledTimes(1)
        unmount()
    })
})
