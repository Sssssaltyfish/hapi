import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useNativeSuggestions } from './useNativeSuggestions'

it('cancels obsolete native suggestions without publishing their results', async () => {
    const requests: Array<{
        signal: AbortSignal
        resolve: (value: { suggestions: { key: string; text: string; label: string }[] }) => void
    }> = []
    const api = {
        getCodexNativeSuggestions: (_id: string, _query: string, signal: AbortSignal) =>
            new Promise((resolve) => requests.push({ signal, resolve })),
    } as unknown as ApiClient
    const { result, unmount } = renderHook(() => useNativeSuggestions(api, 'thread'))
    const old = result.current('@o')
    const current = result.current('@new')
    expect(requests[0].signal.aborted).toBe(true)
    requests[0].resolve({ suggestions: [{ key: 'old', text: 'old', label: 'old' }] })
    requests[1].resolve({ suggestions: [{ key: 'new', text: 'new', label: 'new' }] })
    expect(await old).toEqual([])
    expect(await current).toEqual([{ key: 'new', text: 'new', label: 'new' }])
    unmount()
    expect(requests[1].signal.aborted).toBe(true)
})
