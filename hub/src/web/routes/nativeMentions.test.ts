import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { NativeRegistry } from '../../codexNative/registry'
import { NativeService } from '../../codexNative/service'
import type { WebAppEnv } from '../middleware/auth'
import { createNativeMentionsRoutes } from './nativeMentions'

test('resolves a thread URI by exact authorized Desktop host without guessing between equal thread IDs', async () => {
    const reads: string[] = []
    const registry = new NativeRegistry([
        { id: 'windows', namespace: 'owner', label: 'Windows', endpoint: 'ws://windows', desktopHostId: 'local' },
        { id: 'wsl', namespace: 'owner', label: 'WSL', endpoint: 'unix:///wsl', desktopHostId: 'wsl:Ubuntu' },
        { id: 'other', namespace: 'other', label: 'Other', endpoint: 'ws://other', desktopHostId: 'private' },
    ], config => {
        const service = new NativeService(config)
        service.readThread = async id => { reads.push(config.endpoint!); return { thread: { id } } }
        return service
    })
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'owner'); await next() })
    app.route('/api', createNativeMentionsRoutes(registry))
    const response = await app.request('/api/codex-native/thread-reference?threadId=same-id&hostId=wsl%3AUbuntu')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId: 'codex-native:wsl:same-id', endpointId: 'wsl', threadId: 'same-id', hostId: 'wsl:Ubuntu' })
    expect((await app.request('/api/codex-native/thread-reference?threadId=same-id')).status).toBe(404)
    expect((await app.request('/api/codex-native/thread-reference?threadId=same-id&hostId=private')).status).toBe(404)
    expect(reads).toEqual(['unix:///wsl'])
})
