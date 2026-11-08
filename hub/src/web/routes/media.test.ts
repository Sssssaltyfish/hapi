import { expect, it } from 'bun:test'
import { Hono } from 'hono'
import { MEDIA_CHUNK_BYTES, type ReadMediaRequest } from '@hapi/protocol/apiTypes'
import { resolveMediaConfig, type MediaConfig } from '../../config/media'
import { NativeRegistry } from '../../codexNative/registry'
import { NativeService } from '../../codexNative/service'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMediaRoutes } from './media'

function setup(registry = new NativeRegistry([]), config: Partial<MediaConfig> = {}) {
    const audio = Buffer.alloc(2 * MEDIA_CHUNK_BYTES + 10, '0123456789')
    const ranges: NonNullable<ReadMediaRequest['range']>[] = []
    const session = { id: 'session-1', namespace: 'owner' } as Session
    let available = true
    let version = 'file-v1'
    const engine: Pick<SyncEngine, 'resolveSessionAccess' | 'readMedia'> = {
        resolveSessionAccess(id, namespace) {
            return available && id === session.id && namespace === session.namespace
                ? { ok: true, sessionId: session.id, session }
                : { ok: false, reason: 'access-denied' }
        },
        async readMedia(_id, data) {
            const range = data.range
            if (range) ranges.push(range)
            return {
                success: true, size: audio.byteLength, version, mimeType: 'audio/wav',
                ...(range ? { content: audio.subarray(range.offset, range.offset + range.length).toString('base64') } : {})
            }
        }
    }
    const app = new Hono<WebAppEnv>()
    const routes = createMediaRoutes(() => engine as SyncEngine, registry, resolveMediaConfig(config, {}), new Uint8Array(32))
    app.route('/api', routes.publicRoutes)
    app.use('/api/*', async (c, next) => {
        const namespace = c.req.header('Authorization')?.slice('Bearer '.length)
        if (!namespace) return c.json({ error: 'Unauthorized' }, 401)
        c.set('namespace', namespace)
        return next()
    })
    app.route('/api', routes.authenticatedRoutes)
    const issue = (namespace?: string, body: object = { sessionId: session.id, path: 'sound.wav', mimeType: 'audio/wav' }) =>
        app.request('/api/media/tickets', {
            method: 'POST', headers: namespace ? { Authorization: `Bearer ${namespace}` } : undefined,
            body: JSON.stringify(body)
        })
    const url = async (body?: object) => {
        const response = await issue('owner', body)
        expect(response.status).toBe(200)
        const data = await response.json() as { ticket: string; expiresAt: number }
        expect(data.expiresAt).toBeGreaterThan(Date.now())
        return `/api/media/${data.ticket}`
    }
    return { app, audio, issue, ranges, url, revoke: () => { available = false }, replace: () => { version = 'file-v2' } }
}

it('requires a session-authorized ticket and checks session access again on redemption', async () => {
    const { app, issue, url, revoke } = setup()
    expect((await issue()).status).toBe(401)
    expect((await issue('other')).status).toBe(403)
    expect((await app.request('/api/media/unknown')).status).toBe(404)
    const media = await url()
    revoke()
    expect((await app.request(media)).status).toBe(404)
})

it('serves regular, suffix, and open ranges and handles HEAD without reading runner bytes', async () => {
    const { app, audio, url, ranges } = setup()
    const media = await url({ sessionId: 'session-1', generatedImageId: 'generated-audio' })
    const head = await app.request(media, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('accept-ranges')).toBe('bytes')
    expect(head.headers.get('content-type')).toBe('audio/wav')
    expect(head.headers.get('content-length')).toBe(String(audio.length))
    expect(await head.text()).toBe('')
    const invalid = await app.request(media, { headers: { Range: `bytes=${audio.length}-` } })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe(`bytes */${audio.length}`)
    expect(ranges).toHaveLength(0)
    for (const [header, start, end] of [
        ['bytes=3-5', 3, 5], ['bytes=-3', audio.length - 3, audio.length - 1],
        [`bytes=${audio.length - 2}-`, audio.length - 2, audio.length - 1]
    ] as const) {
        const response = await app.request(media, { headers: { Range: header } })
        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${audio.length}`)
        expect(await response.text()).toBe(audio.subarray(start, end + 1).toString())
    }
})

it('renews stable image URLs and uses validators without returning bytes for a matching version', async () => {
    const { app, url, ranges, replace, revoke } = setup(undefined, { browserMaxAgeSeconds: 60, ticketTtlSeconds: 30 })
    const body = { sessionId: 'session-1', path: 'diagram.svg', mimeType: 'image/svg+xml' }
    const media = await url(body)
    expect(await url(body)).toBe(media)
    const head = await app.request(media, { method: 'HEAD' })
    const etag = head.headers.get('etag')!
    expect(etag).toMatch(/^".+"$/)
    expect(head.headers.get('content-type')).toBe('image/svg+xml')
    expect(head.headers.get('content-security-policy')).toContain('sandbox')
    const maxAge = Number(/max-age=(\d+)/.exec(head.headers.get('cache-control') ?? '')?.[1])
    expect(maxAge).toBeGreaterThan(0)
    expect(maxAge).toBeLessThanOrEqual(30)
    const cached = await app.request(media, { headers: { 'If-None-Match': `W/${etag}` } })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe(etag)
    expect(ranges).toHaveLength(0)
    const partial = await app.request(media, { headers: { Range: 'bytes=0-1', 'If-Range': etag } })
    expect(partial.status).toBe(206)
    expect(await partial.text()).toBe('01')

    replace()
    const newer = await url(body)
    expect(newer).not.toBe(media)
    expect((await app.request(media, { headers: { 'If-None-Match': etag } })).status).toBe(409)
    const full = await app.request(newer, { headers: { Range: 'bytes=0-1', 'If-Range': etag } })
    expect(full.status).toBe(200)
    await full.body?.cancel()
    revoke()
    expect((await app.request(newer, { headers: { 'If-None-Match': '*' } })).status).toBe(404)
})

it('stops asking the runner for blocks when the response is canceled', async () => {
    const { app, audio, url, ranges } = setup()
    const media = await url()
    const response = await app.request(media, { headers: { Range: 'bytes=5-' } })
    const reader = response.body!.getReader()
    expect(ranges).toHaveLength(0)
    const first = await reader.read()
    expect(Buffer.from(first.value!).equals(audio.subarray(5, 5 + MEDIA_CHUNK_BYTES))).toBe(true)
    await reader.cancel()
    expect(ranges).toEqual([{ offset: 5, length: MEDIA_CHUNK_BYTES, version: 'file-v1' }])
})

it('imports one native file for concurrent range requests', async () => {
    const config = { id: 'desktop', label: 'Desktop', namespace: 'owner', endpoint: 'ws://local', fileAccess: 'host' as const }
    let imports = 0
    class TestService extends NativeService {
        override async call(method: string): Promise<unknown> {
            if (method === 'thread/read') return { thread: { cwd: '/workspace' } }
            if (method === 'fs/getMetadata') return { isFile: true, createdAtMs: 1, modifiedAtMs: 2 }
            if (method === 'fs/readFile') {
                imports += 1
                return { dataBase64: Buffer.from('0123456789').toString('base64') }
            }
            throw new Error(method)
        }
    }
    const registry = new NativeRegistry([config], (config) => new TestService(config))
    const { app, issue, url } = setup(registry)
    const body = { sessionId: 'codex-native:desktop:thread', path: 'sample.mp4', mimeType: 'video/mp4' }
    expect((await issue('other', body)).status).toBe(404)
    const media = await url(body)
    expect(imports).toBe(0)
    const [a, b] = await Promise.all([
        app.request(media, { headers: { Range: 'bytes=1-2' } }),
        app.request(media, { headers: { Range: 'bytes=-2' } })
    ])
    expect(a.status).toBe(206)
    expect(b.status).toBe(206)
    expect(await a.text()).toBe('12')
    expect(await b.text()).toBe('89')
    expect(imports).toBe(1)
    const restarted = setup(registry)
    expect(await restarted.url(body)).toBe(media)
    const cached = await restarted.app.request(media, { headers: { 'If-None-Match': a.headers.get('etag')! } })
    expect(cached.status).toBe(304)
    expect(imports).toBe(1)
})
