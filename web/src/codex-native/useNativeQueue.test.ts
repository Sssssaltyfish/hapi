import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { NativeEvent } from './types'
import { useNativeQueue } from './useNativeQueue'

it('reads all daemon pages and replaces a stale read when queue changes during it', async () => {
    let changed!: (event: NativeEvent) => void
    const subscribe = (listener: typeof changed) => { changed = listener; return () => {} }
    let finish!: (page: { data: { id: string }[]; nextCursor: null }) => void
    const pending = new Promise<{ data: { id: string }[]; nextCursor: null }>(resolve => { finish = resolve })
    const get = vi.fn().mockResolvedValueOnce({ data: [{ id: 'first' }], nextCursor: 'next' })
        .mockResolvedValueOnce({ data: [{ id: 'second' }], nextCursor: null }).mockReturnValueOnce(pending)
        .mockResolvedValue({ data: [], nextCursor: null })
    const api = { getCodexNativeQueue: get } as unknown as ApiClient
    const { result, unmount } = renderHook(() => useNativeQueue(api, 'thread', true, subscribe))
    await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual(['first', 'second']))
    expect(get).toHaveBeenCalledWith('thread', 'next')
    act(() => changed({ method: 'thread/queue/changed', params: { threadId: 'thread' } }))
    act(() => changed({ method: 'thread/queue/changed', params: { threadId: 'thread' } }))
    await act(async () => { finish({ data: [{ id: 'consumed-old-item' }], nextCursor: null }) })
    await waitFor(() => expect(result.current.items).toEqual([]))
    expect(get).toHaveBeenCalledTimes(4)
    act(() => changed({ method: 'hapi/ready', params: {} }))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(5))
    unmount()
})
