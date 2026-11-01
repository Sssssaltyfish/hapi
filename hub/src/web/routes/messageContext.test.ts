import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

test('source resolution checks session access before reading persisted content', async () => {
    const calls: string[][] = []
    const engine = {
        resolveSessionAccess: (sessionId: string, namespace: string) => namespace === 'owner'
            ? { ok: true, sessionId, session: { active: false } }
            : { ok: false, reason: 'access-denied' },
        getMessageContext: (sessionId: string, messageId: string) => {
            calls.push([sessionId, messageId])
            return messageId === 'missing' ? null : { message: { id: messageId } }
        },
    } as unknown as SyncEngine
    const app = (namespace: string) => {
        const result = new Hono<WebAppEnv>()
        result.use('*', async (c, next) => { c.set('namespace', namespace); await next() })
        result.route('/api', createMessagesRoutes(() => engine))
        return result
    }
    expect((await app('owner').request('/api/sessions/session/messages/source/context')).status).toBe(200)
    expect((await app('owner').request('/api/sessions/session/messages/missing/context')).status).toBe(404)
    expect((await app('other').request('/api/sessions/session/messages/source/context')).status).toBe(403)
    expect(calls).toEqual([['session', 'source'], ['session', 'missing']])
})
