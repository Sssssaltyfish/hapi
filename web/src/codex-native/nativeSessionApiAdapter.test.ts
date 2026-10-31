import { expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { createNativeSessionApiAdapter } from './nativeSessionApiAdapter'

it('preserves cache identity and reads the bound native outline through the real client', async () => {
    const token = `header.${btoa(JSON.stringify({ ns: 'test', uid: 'reader' }))}.signature`
    const client = new ApiClient(token, { baseUrl: 'https://hub.example' }).withCodexNativeEndpoint('windows')
    const session = {
        id: 'native-session',
        metadata: { nativeCodex: { endpointId: 'windows', threadId: 'thread' } },
    } as Session
    const adapter = createNativeSessionApiAdapter(client, {
        session,
        liveSession: session,
        thread: { requests: [], detail: {}, refreshDetail: vi.fn(), applySettings: vi.fn() },
        projected: { requests: {} },
        setSettingsError: vi.fn(),
    })
    const originalFetch = globalThis.fetch
    const page = { items: [], next: null, scanned: 1, epoch: null, reachedHead: false }
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page), { status: 200 }))
    globalThis.fetch = fetchMock
    try {
        expect(adapter.getConversationCacheScope()).toEqual(client.getConversationCacheScope())
        expect(adapter.getConversationCacheScope().persistent).toBe(true)
        await expect(adapter.getConversationOutline(session.id, { kind: 'native', cursor: 'opaque' }, ['known-user'])).resolves.toEqual(page)
        const url = new URL(String(fetchMock.mock.calls[0][0]))
        expect(url.pathname).toBe('/api/codex-native/threads/thread/outline')
        expect(url.searchParams.get('endpointId')).toBe('windows')
        expect(url.searchParams.get('cursor')).toBe('opaque')
        expect(url.searchParams.get('stopIds')).toBe('["known-user"]')
        await expect(adapter.getConversationOutline(session.id, {
            kind: 'runner', beforeAt: null, beforeSeq: null, epoch: null,
        })).rejects.toThrow('native history locator')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
        globalThis.fetch = originalFetch
    }
})
