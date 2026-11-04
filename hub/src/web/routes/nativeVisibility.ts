import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { NativeRegistry } from '../../codexNative/registry'

const id = z.string().min(1).max(200)
const actionSchema = z.union([
    z.object({ action: z.enum(['track-thread', 'hide-thread']), threadId: id }).strict(),
    z.object({ action: z.enum(['track-project', 'hide-project', 'discover-project']), projectId: id }).strict(),
])
export function createNativeVisibilityRoutes(registry: NativeRegistry): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/codex-native/endpoints/:endpointId/visibility', async c =>
        c.json(await registry.visibilitySnapshot(c.get('namespace'), c.req.param('endpointId'))))
    app.post('/codex-native/endpoints/:endpointId/visibility', async c => {
        const parsed = actionSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid native visibility selection' }, 400)
        return c.json(await registry.changeVisibility(c.get('namespace'), c.req.param('endpointId'), parsed.data))
    })
    return app
}
