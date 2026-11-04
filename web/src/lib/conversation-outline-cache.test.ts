import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import { firstOutlinePage, getOutlineCache, mergeOutlineItems } from './conversation-outline-cache'

describe('outline cache bounds and identity', () => {
    it('enforces a UTF-8 byte budget without marking an unretained continuation complete', () => {
        const cache = getOutlineCache('byte-budget', true, false)
        const retained = mergeOutlineItems(cache, [{ id: 'oversized', targetMessageId: 'oversized', kind: 'user', createdAt: 0,
            label: '界'.repeat(3_000_000) }])
        expect(retained).toBe(false)
        expect(cache.capped).toBe(true)
        expect(cache.next).toEqual(firstOutlinePage(true))
        expect(cache.items).toEqual([])
    })

    it('isolates origin, namespace and account without putting a JWT in persistent cache keys', () => {
        let claims = { uid: 1, ns: 'one' }
        const getToken = () => `test.${btoa(JSON.stringify(claims))}.signature`
        const api = new ApiClient('', { baseUrl: 'https://first.example', getToken })
        const first = api.getConversationCacheScope()
        claims = { uid: 2, ns: 'one' }
        const otherAccount = api.getConversationCacheScope()
        claims = { uid: 1, ns: 'two' }
        const otherNamespace = api.getConversationCacheScope()
        const otherOrigin = new ApiClient('', { baseUrl: 'https://second.example', getToken }).getConversationCacheScope()
        expect(first.persistent).toBe(true)
        expect(new Set([first.key, otherAccount.key, otherNamespace.key, otherOrigin.key]).size).toBe(4)
        expect(first.key).not.toContain('signature')
        let token = 'unidentified-a'
        const unidentified = new ApiClient('', { getToken: () => token })
        const memory = unidentified.getConversationCacheScope()
        token = 'unidentified-b'
        expect(unidentified.getConversationCacheScope()).toMatchObject({ persistent: false })
        expect(unidentified.getConversationCacheScope().key).not.toBe(memory.key)
    })

    it('continues with the memory index when IndexedDB cannot be opened', async () => {
        vi.stubGlobal('indexedDB', { open: () => { throw new Error('storage unavailable') } })
        try {
            const cache = getOutlineCache('idb-unavailable', true, true)
            await cache.hydrated
            expect(mergeOutlineItems(cache, [{ id: 'preview', targetMessageId: 'preview', kind: 'user', label: 'retained', createdAt: 0 }])).toBe(true)
            expect(cache.items[0].label).toBe('retained')
            const sameItems = cache.items
            const sameBytes = cache.bytes
            mergeOutlineItems(cache, [{ ...cache.items[0] }, { id: 'failed', targetMessageId: 'failed', kind: 'user', label: 'unsent', createdAt: 1, transient: true }])
            expect(cache.items).toBe(sameItems)
            expect(cache.bytes).toBe(sameBytes)
        } finally { vi.stubGlobal('indexedDB', undefined) }
    })
})
