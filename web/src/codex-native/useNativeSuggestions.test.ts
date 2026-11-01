import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useNativeSuggestions } from './useNativeSuggestions'
import type { SessionSummary } from '@/types/api'

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

it('offers only authorized mapped native peers and keeps equal thread IDs on different hosts distinct', async () => {
    const current = { id: 'codex-native:windows:same', active: true, updatedAt: 1, hasConversationContent: true, metadata: { name: 'Current', flavor: 'codex', nativeCodex: { endpointId: 'windows', threadId: 'same' } } } as SessionSummary
    const peer = { ...current, id: 'codex-native:wsl:same', metadata: { ...current.metadata, name: 'WSL peer', nativeCodex: { endpointId: 'wsl', threadId: 'same' } } } as SessionSummary
    const unknown = { ...peer, id: 'codex-native:unmapped:other', metadata: { ...peer.metadata, nativeCodex: { endpointId: 'unmapped', threadId: 'other' } } } as SessionSummary
    const api = { getCodexNativeSuggestions: async () => ({ suggestions: [], canReferenceThreads: true }) } as unknown as ApiClient
    const { result } = renderHook(() => useNativeSuggestions(api, 'same', {
        endpointId: 'windows', sessions: [current, peer, unknown], endpoints: [
            { id: 'windows', label: 'Windows', address: 'local', source: 'env', desktopHostId: 'local' },
            { id: 'wsl', label: 'WSL', address: 'remote', source: 'env', desktopHostId: 'wsl:Ubuntu' },
        ],
    }))
    const suggestions = await result.current('@')
    expect(suggestions.map(suggestion => suggestion.sessionMention?.id)).toEqual(['codex-native:wsl:same'])
    expect(suggestions[0].group).toBe('threads')
})
