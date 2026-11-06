import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { AppIconStore, MAX_APP_ICON_BYTES, normalizeAppIcon, getAppIconType, type AppIconType } from '../appIcon'
import type { WebAppEnv } from '../middleware/auth'

export function createPublicAppIconRoutes(store: AppIconStore): Hono {
    const app = new Hono()
    app.get('/app-icon/image', async (c) => {
        c.header('Cache-Control', 'no-store')
        const icon = await store.read()
        if (!icon) return c.redirect('/pwa-512x512.png', 307)
        c.header('Content-Type', icon.type)
        c.header('X-Content-Type-Options', 'nosniff')
        return c.body(new Uint8Array(icon.bytes))
    })
    // Apple web clips use PNG. Generate the small derivative on demand without
    // retaining another file or a previous version of the user's icon.
    app.get('/app-icon/apple-touch', async (c) => {
        c.header('Cache-Control', 'no-store')
        const icon = await store.read()
        if (!icon) return c.redirect('/apple-touch-icon-180x180.png', 307)
        c.header('Content-Type', 'image/png')
        c.header('X-Content-Type-Options', 'nosniff')
        const png = await new Bun.Image(icon.bytes, { maxPixels: 512 * 512 }).resize(180, 180).png().bytes()
        return c.body(new Uint8Array(png))
    })
    return app
}

export function createAppIconRoutes(store: AppIconStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/app-icon', async (c) => {
        c.header('Cache-Control', 'no-store')
        const icon = await store.read()
        return c.json({ revision: icon?.revision ?? null, type: icon?.type ?? null, canEdit: c.get('namespace') === 'default' })
    })
    app.use('/app-icon', async (c, next) => {
        if (c.get('namespace') !== 'default') return c.json({ error: 'Only the hub owner can change the app icon' }, 403)
        return next()
    })
    app.put('/app-icon', bodyLimit({ maxSize: MAX_APP_ICON_BYTES }), async (c) => {
        const type = c.req.header('Content-Type')
        if (type !== 'image/png' && type !== 'image/webp') return c.json({ error: 'Expected image/png or image/webp' }, 400)
        // Read outside the image-validation catch so bodyLimit's streamed 413
        // reaches Hono instead of becoming an invalid-image 400.
        const input = Buffer.from(await c.req.arrayBuffer())
        let bytes: Buffer
        try {
            if (getAppIconType(input) !== type) throw new Error('Image type mismatch')
            bytes = await normalizeAppIcon(input)
        }
        catch { return c.json({ error: 'Expected a valid 512 × 512 PNG or WebP' }, 400) }
        await store.replace(bytes)
        c.header('Cache-Control', 'no-store')
        const icon = await store.read()
        return c.json({ revision: icon?.revision ?? null, type: icon?.type ?? null, canEdit: true })
    })
    app.delete('/app-icon', async (c) => {
        await store.reset()
        c.header('Cache-Control', 'no-store')
        return c.json({ revision: null, type: null, canEdit: true })
    })
    return app
}

export function withAppIcon(manifest: Record<string, unknown>, revision: string | null, type: AppIconType = 'image/png'): Record<string, unknown> {
    return revision ? { ...manifest, icons: [{ src: `/api/app-icon/image?v=${revision}`, sizes: '512x512', type, purpose: 'any' }] } : manifest
}
