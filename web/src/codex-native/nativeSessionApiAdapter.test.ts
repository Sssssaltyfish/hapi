import { expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import { createNativeSessionApiAdapter } from './nativeSessionApiAdapter'
import type { NativeRequest } from './types'

it('sends only the chosen model when its cached effort is stale', async () => {
    const client = {
        getCodexNativeModels: vi.fn().mockResolvedValue({ data: [{ id: 'target', defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'medium' }] }] }),
        codexNativeAction: vi.fn().mockResolvedValue({ applied: { model: 'target', effort: 'high' } }),
    }
    const applySettings = vi.fn()
    const adapter = createNativeSessionApiAdapter(client as unknown as ApiClient, {
        sessionId: 'session', threadId: 'thread', setSettingsError: vi.fn(),
        getState: () => ({ model: 'old', projectedRequests: {},
            thread: { requests: [], detail: {}, refreshDetail: vi.fn(), applySettings } }),
    })
    await adapter.setModel('session', 'target')
    expect(client.codexNativeAction).toHaveBeenCalledWith('thread', 'settings', { model: 'target' })
    expect(applySettings).toHaveBeenCalledWith({ model: 'target', effort: 'high' })
})

it('checks current pending requests through a previously captured approval handler', async () => {
    const codexNativeAction = vi.fn().mockResolvedValue({})
    let requests: NativeRequest[] = []
    const adapter = createNativeSessionApiAdapter({ codexNativeAction } as unknown as ApiClient, {
        sessionId: 'session', threadId: 'thread', setSettingsError: vi.fn(),
        getState: () => ({ model: null, projectedRequests: {},
            thread: { requests, detail: {}, refreshDetail: vi.fn(), applySettings: vi.fn() } }),
    })
    const approve = adapter.approvePermission
    requests = [{ id: 21, method: 'item/commandExecution/requestApproval', params: {} }]
    await approve('session', '21')
    expect(codexNativeAction).toHaveBeenCalledWith('thread', 'requests/21', { result: { decision: 'accept' } })
    requests = []
    await expect(approve('session', '21')).rejects.toThrow('Native request is no longer pending')
    expect(codexNativeAction).toHaveBeenCalledTimes(1)
})

it('preserves cache identity and reads the bound native outline through the real client', async () => {
    const token = `header.${btoa(JSON.stringify({ ns: 'test', uid: 'reader' }))}.signature`
    const client = new ApiClient(token, { baseUrl: 'https://hub.example' }).withCodexNativeEndpoint('windows')
    const sessionId = 'native-session'
    const adapter = createNativeSessionApiAdapter(client, {
        sessionId, threadId: 'thread',
        getState: () => ({ model: null, projectedRequests: {},
            thread: { requests: [], detail: {}, refreshDetail: vi.fn(), applySettings: vi.fn() } }),
        setSettingsError: vi.fn(),
    })
    const originalFetch = globalThis.fetch
    const page = { items: [], next: null, scanned: 1, epoch: null, reachedHead: false }
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page), { status: 200 }))
    globalThis.fetch = fetchMock
    try {
        expect(adapter.getConversationCacheScope()).toEqual(client.getConversationCacheScope())
        expect(adapter.getConversationCacheScope().persistent).toBe(true)
        await expect(adapter.getConversationOutline(sessionId, { kind: 'native-turns', cursor: 'opaque' }, ['known-user'])).resolves.toEqual(page)
        const url = new URL(String(fetchMock.mock.calls[0][0]))
        expect(url.pathname).toBe('/api/codex-native/threads/thread/outline')
        expect(url.searchParams.get('endpointId')).toBe('windows')
        expect(url.searchParams.get('cursor')).toBe('opaque')
        expect(url.searchParams.get('stopIds')).toBe('["known-user"]')
        await expect(adapter.getConversationOutline(sessionId, {
            kind: 'runner', beforeAt: null, beforeSeq: null, epoch: null,
        })).rejects.toThrow('turn-summary continuation')
        await adapter.getCodexNativeTurnContext('unbound-thread', 'turn-id', 'user-id')
        const contextUrl = new URL(String(fetchMock.mock.calls[1][0]))
        expect(contextUrl.pathname).toBe('/api/codex-native/threads/thread/outline-context')
        expect(contextUrl.searchParams.get('endpointId')).toBe('windows')
        expect(contextUrl.searchParams.get('turnId')).toBe('turn-id')
        expect(contextUrl.searchParams.get('itemId')).toBe('user-id')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
        globalThis.fetch = originalFetch
    }
})
