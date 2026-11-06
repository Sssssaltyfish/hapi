import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { AppIconStore, MAX_APP_ICON_BYTES, normalizeAppIcon } from '../appIcon'
import type { WebAppEnv } from '../middleware/auth'

export function createPublicAppIconRoutes(store: AppIconStore): Hono {
    const app = new Hono()
    app.get('/app-icon/image', async (c) => {
        c.header('Cache-Control', 'no-store')
        const icon = await store.read()
        if (!icon) return c.redirect('/pwa-512x512.png', 307)
        c.header('Content-Type', 'image/png')
        c.header('X-Content-Type-Options', 'nosniff')
        return c.body(new Uint8Array(icon.bytes))
    })
    return app
}

export function createAppIconRoutes(store: AppIconStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/app-icon', async (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json({ revision: (await store.read())?.revision ?? null, canEdit: c.get('namespace') === 'default' })
    })
    app.use('/app-icon', async (c, next) => {
        if (c.get('namespace') !== 'default') return c.json({ error: 'Only the hub owner can change the app icon' }, 403)
        return next()
    })
    app.put('/app-icon', bodyLimit({ maxSize: MAX_APP_ICON_BYTES }), async (c) => {
        if (c.req.header('Content-Type') !== 'image/png') return c.json({ error: 'Expected image/png' }, 400)
        let bytes: Buffer
        try { bytes = normalizeAppIcon(new Uint8Array(await c.req.arrayBuffer())) }
        catch { return c.json({ error: 'Expected a valid 512 × 512 PNG' }, 400) }
        await store.replace(bytes)
        c.header('Cache-Control', 'no-store')
        return c.json({ revision: (await store.read())?.revision ?? null, canEdit: true })
    })
    app.delete('/app-icon', async (c) => {
        await store.reset()
        c.header('Cache-Control', 'no-store')
        return c.json({ revision: null, canEdit: true })
    })
    return app
}

export function withAppIcon(manifest: Record<string, unknown>, revision: string | null): Record<string, unknown> {
    return revision ? { ...manifest, icons: [{ src: `/api/app-icon/image?v=${revision}`, sizes: '512x512', type: 'image/png', purpose: 'any' }] } : manifest
}
