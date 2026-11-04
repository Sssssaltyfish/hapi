import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../web/middleware/auth'
import { createCodexNativeRoutes } from '../web/routes/codexNative'
import { NativeService } from './service'
import { nativeItemLookup } from './itemLookup'
import type { NativeRecord } from './transport'

describe('native quote source reads', () => {
    test('requests exactly one persisted item and preserves daemon metadata', async () => {
        const calls: NativeRecord[] = []
        const entry = { turnId: 'turn', startedAtMs: 123, completedAtMs: 456, item: { id: 'response', type: 'agentMessage', text: 'original' } }
        const result = await nativeItemLookup(async params => {
            calls.push(params)
            return { data: [entry] }
        }, 'turn', 'response')
        expect(calls).toEqual([{ turnId: 'turn', itemIds: ['response'] }])
        expect(result).toEqual(entry)
        expect(await nativeItemLookup(async () => ({ data: [{ ...entry, turnId: 'other-turn' }] }), 'turn', 'response')).toBeNull()
        expect(await nativeItemLookup(async () => { throw new Error('turn with id turn not found') }, 'turn', 'response')).toBeNull()
        await expect(nativeItemLookup(async () => { throw new Error('Native connection unavailable') }, 'turn', 'response')).rejects.toThrow('Native connection unavailable')
    })

    test('validates locators and forwards only read RPCs behind namespace access', async () => {
        const service = new NativeService({ endpoint: 'ws://existing', namespace: 'owner' })
        const calls: Array<{ method: string; params: NativeRecord }> = []
        service.control = async (_threadId, method, params) => {
            calls.push({ method, params })
            return method === 'thread/items/read'
                ? { data: [{ turnId: 'turn', item: { id: 'response', type: 'agentMessage', text: 'original' } }] }
                : { data: [], nextCursor: null, backwardsCursor: null }
        }
        const app = (namespace: string) => {
            const routes = new Hono<WebAppEnv>()
            routes.use('*', async (c, next) => { c.set('namespace', namespace); await next() })
            routes.route('/api', createCodexNativeRoutes(service))
            return routes
        }
        expect((await app('owner').request('/api/codex-native/threads/thread/items/response?turnId=turn')).status).toBe(200)
        const response = await app('owner').request('/api/codex-native/threads/thread/turn-items/read', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ turnId: 'turn', cursor: { type: 'item', itemId: 'response' }, sortDirection: 'desc', limit: 20 }),
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual([
            { method: 'thread/items/read', params: { turnId: 'turn', itemIds: ['response'] } },
            { method: 'thread/items/list', params: { turnId: 'turn', cursor: { type: 'item', itemId: 'response' }, sortDirection: 'desc', limit: 20 } },
        ])
        expect((await app('other').request('/api/codex-native/threads/thread/items/response?turnId=turn')).status).toBe(404)
        expect((await app('owner').request('/api/codex-native/threads/thread/items/response')).status).toBe(400)
        expect(calls).toHaveLength(2)
    })
})
