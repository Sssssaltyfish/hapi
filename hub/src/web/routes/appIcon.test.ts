import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { AppIconStore } from '../appIcon'
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
    return { app, dataDir }
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
    })

    it('replaces the single stored crop, changes its revision, rejects invalid input, and resets', async () => {
        const { app, dataDir } = await setup()
        const headers = { authorization: `Bearer ${await token('default')}`, 'content-type': 'image/png' }
        const first = await app.request('/api/app-icon', { method: 'PUT', headers, body: await fixture('pwa-512x512.png') })
        expect(first.status).toBe(200)
        const firstStatus = await first.json() as { revision: string }
        const bytes = await fixture('pwa-maskable-512x512.png')
        const second = await app.request('/api/app-icon', { method: 'PUT', headers, body: bytes })
        expect(second.status).toBe(200)
        expect((await second.json() as { revision: string }).revision).not.toBe(firstStatus.revision)
        expect(await readdir(dataDir)).toEqual(['app-icon.png'])
        expect(Buffer.from(await (await app.request('/api/app-icon/image')).arrayBuffer())).toEqual(bytes)
        expect((await app.request('/api/app-icon', { method: 'PUT', headers, body: await fixture('pwa-192x192.png') })).status).toBe(400)
        expect(await readFile(join(dataDir, 'app-icon.png'))).toEqual(bytes)
        expect((await app.request('/api/app-icon', { method: 'DELETE', headers })).status).toBe(200)
        expect(await readdir(dataDir)).toEqual([])
    })

    it('changes only manifest icons and preserves installation identity and share target', () => {
        const manifest = { name: 'HAPI', start_url: '/', scope: '/', share_target: { action: '/share', method: 'POST' }, icons: [{ src: 'original.png' }] }
        expect(withAppIcon(manifest, null)).toBe(manifest)
        const customized = withAppIcon(manifest, 'abc')
        expect({ ...customized, icons: manifest.icons }).toEqual(manifest)
        expect(customized.icons).toEqual([{ src: '/api/app-icon/image?v=abc', sizes: '512x512', type: 'image/png', purpose: 'any' }])
    })
})
