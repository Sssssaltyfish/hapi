import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { AppIconStore, MAX_APP_ICON_BYTES } from '../appIcon'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createAppIconRoutes, createPublicAppIconRoutes, withAppIcon } from './appIcon'

const directories: string[] = []
const secret = new TextEncoder().encode('app-icon-test-secret-at-least-32-bytes')
const fixture = (name: string) => readFile(join(import.meta.dir, '../../../../web/public', name))
const token = async (namespace: string) => new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), 'hapi-app-icon-'))
    directories.push(dataDir)
    const store = new AppIconStore(dataDir)
    const app = new Hono<WebAppEnv>()
    app.route('/api', createPublicAppIconRoutes(store))
    app.use('/api/*', createAuthMiddleware(secret))
    app.route('/api', createAppIconRoutes(store))
    return { app, dataDir, store }
}

describe('app icon', () => {
    it('requires owner authorization for changes and allows public image reads', async () => {
        const { app } = await setup()
        const bytes = await fixture('pwa-512x512.png')
        expect((await app.request('/api/app-icon', { method: 'PUT', body: bytes })).status).toBe(401)
        for (const method of ['PUT', 'DELETE']) {
            expect((await app.request('/api/app-icon', { method, headers: { authorization: `Bearer ${await token('tenant')}`, 'content-type': 'image/png' }, body: method === 'PUT' ? bytes : undefined })).status).toBe(403)
        }
        const image = await app.request('/api/app-icon/image')
        expect(image.status).toBe(307)
        expect(image.headers.get('cache-control')).toBe('no-store')
        for (const size of [64, 192]) expect((await app.request(`/api/app-icon/image?size=${size}`)).headers.get('location')).toBe(`/pwa-${size}x${size}.png`)
        expect((await app.request('/api/app-icon/apple-touch')).headers.get('location')).toBe('/apple-touch-icon-180x180.png')
    })

    it('replaces the single stored crop, changes its revision, rejects invalid input, and resets', async () => {
        const { app, dataDir } = await setup()
        const headers = { authorization: `Bearer ${await token('default')}`, 'content-type': 'image/png' }
        const first = await app.request('/api/app-icon', { method: 'PUT', headers, body: await fixture('pwa-512x512.png') })
        expect(first.status).toBe(200)
        const firstStatus = await first.json() as { revision: string; type: string }
        expect(firstStatus.type).toBe('image/webp')
        const bytes = await new Bun.Image(await fixture('pwa-maskable-512x512.png')).webp({ quality: 80 }).buffer()
        const second = await app.request('/api/app-icon', { method: 'PUT', headers: { ...headers, 'content-type': 'image/webp' }, body: bytes })
        expect(second.status).toBe(200)
        expect((await second.json() as { revision: string }).revision).not.toBe(firstStatus.revision)
        expect(await readdir(dataDir)).toEqual(['app-icon.webp'])
        const image = await app.request('/api/app-icon/image')
        expect(image.headers.get('content-type')).toBe('image/webp')
        expect(Buffer.from(await image.arrayBuffer()).equals(bytes)).toBe(true)
        for (const size of [64, 192]) {
            const derivative = await app.request(`/api/app-icon/image?size=${size}`)
            expect(derivative.headers.get('content-type')).toBe('image/webp')
            expect(derivative.headers.get('cache-control')).toBe('no-cache')
            expect(await new Bun.Image(await derivative.arrayBuffer()).metadata()).toMatchObject({ width: size, height: size, format: 'webp' })
            const cached = await app.request(`/api/app-icon/image?size=${size}`, { headers: { 'if-none-match': derivative.headers.get('etag')! } })
            expect(cached.status).toBe(304)
            expect((await cached.arrayBuffer()).byteLength).toBe(0)
        }
        const apple = await app.request('/api/app-icon/apple-touch')
        expect(apple.headers.get('content-type')).toBe('image/png')
        expect(await new Bun.Image(await apple.arrayBuffer()).metadata()).toMatchObject({ width: 180, height: 180, format: 'png' })
        expect((await app.request('/api/app-icon/apple-touch', { headers: { 'if-none-match': apple.headers.get('etag')! } })).status).toBe(304)
        expect(await readdir(dataDir)).toEqual(['app-icon.webp'])
        expect((await app.request('/api/app-icon', { method: 'PUT', headers, body: await fixture('pwa-192x192.png') })).status).toBe(400)
        expect((await app.request('/api/app-icon', { method: 'PUT', headers, body: bytes })).status).toBe(400)
        expect((await app.request('/api/app-icon', { method: 'PUT', headers, body: Buffer.alloc(MAX_APP_ICON_BYTES + 1) })).status).toBe(413)
        expect((await readFile(join(dataDir, 'app-icon.webp'))).equals(bytes)).toBe(true)
        expect((await app.request('/api/app-icon', { method: 'DELETE', headers })).status).toBe(200)
        expect(await readdir(dataDir)).toEqual([])
    })

    it('reads a legacy PNG and removes it when replacing or resetting across concurrent store instances', async () => {
        const { app, dataDir, store } = await setup()
        const legacy = await fixture('pwa-512x512.png')
        await writeFile(join(dataDir, 'app-icon.png'), legacy)
        const image = await app.request('/api/app-icon/image')
        expect(image.headers.get('content-type')).toBe('image/png')
        expect(Buffer.from(await image.arrayBuffer())).toEqual(legacy)
        const favicon = await app.request('/api/app-icon/image?size=64')
        expect(favicon.headers.get('content-type')).toBe('image/png')
        expect(await new Bun.Image(await favicon.arrayBuffer()).metadata()).toMatchObject({ width: 64, height: 64, format: 'png' })
        expect((await store.read())?.type).toBe('image/png')
        const webp = await new Bun.Image(legacy).webp({ quality: 80 }).buffer()
        const another = new AppIconStore(dataDir)
        await Promise.all([store.replace(webp), another.reset(), another.replace(webp)])
        expect(await readdir(dataDir)).toEqual(['app-icon.webp'])
        expect((await store.read())?.bytes).toEqual(webp)
        await writeFile(join(dataDir, 'app-icon.png'), legacy)
        await another.reset()
        expect(await readdir(dataDir)).toEqual([])
    })

    it('changes only manifest icons and preserves installation identity and share target', () => {
        const manifest = { name: 'HAPI', start_url: '/', scope: '/', share_target: { action: '/share', method: 'POST' }, icons: [{ src: 'original.png' }] }
        expect(withAppIcon(manifest, null)).toBe(manifest)
        const customized = withAppIcon(manifest, 'abc')
        expect({ ...customized, icons: manifest.icons }).toEqual(manifest)
        expect(customized.icons).toEqual([
            { src: '/api/app-icon/image?size=192&v=abc', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/api/app-icon/image?v=abc', sizes: '512x512', type: 'image/png', purpose: 'any' }
        ])
        expect(withAppIcon(manifest, 'webp', 'image/webp').icons).toEqual([
            { src: '/api/app-icon/image?size=192&v=webp', sizes: '192x192', type: 'image/webp', purpose: 'any' },
            { src: '/api/app-icon/image?v=webp', sizes: '512x512', type: 'image/webp', purpose: 'any' }
        ])
    })
})
