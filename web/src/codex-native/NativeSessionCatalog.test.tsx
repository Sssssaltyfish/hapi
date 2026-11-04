import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { NativeEvent } from './types'
import { NativeSessionCatalog } from './NativeSessionCatalog'
import { queryKeys } from '@/lib/query-keys'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it('ignores heartbeats and unknown status changes, and scopes catalog refreshes to their endpoint', async () => {
    let receive: (event: NativeEvent) => void = () => {}
    const api = {
        getConversationCacheScope: () => ({ key: 'user' }),
        getCodexNativeEndpoints: vi.fn().mockResolvedValue({ endpoints: [{ id: 'one' }] }),
        streamCodexNativeCatalog: vi.fn((_id: string, _signal: AbortSignal, callback: (event: NativeEvent) => void) => { receive = callback; return new Promise<void>(() => {}) }),
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    client.setQueryData(queryKeys.sessions, { sessions: [{ id: 'known', metadata: { nativeCodex: { endpointId: 'one', threadId: 'tracked' } } }] })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(<QueryClientProvider client={client}><NativeSessionCatalog api={api as unknown as ApiClient} /></QueryClientProvider>)
    await waitFor(() => expect(api.streamCodexNativeCatalog).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    act(() => { receive({ method: 'hapi/heartbeat', params: {} }); receive({ method: 'thread/status/changed', params: { threadId: 'not-tracked' } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(invalidate).not.toHaveBeenCalled()
    act(() => receive({ method: 'thread/status/changed', params: { threadId: 'tracked' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: queryKeys.sessions })
    invalidate.mockClear()
    act(() => receive({ method: 'project/changed', params: { projectId: 'project' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(invalidate.mock.calls.some(([filters]) => filters?.queryKey?.[0] === 'codex-native-catalog' && filters.queryKey[2] === 'one')).toBe(true)
    client.clear()
})
