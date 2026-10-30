import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import type { NativeRegistry } from '../../codexNative/registry'

export function createNativeMentionsRoutes(registry: NativeRegistry): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/codex-native/threads/:id/suggestions', async (c) => {
        const endpoint = registry.get(c.get('namespace'), c.req.query('endpointId'))
        if (!endpoint) return c.json({ error: 'Native endpoint not found' }, 404)
        const suggestions = await endpoint.service.suggestions(
            c.req.param('id'),
            c.req.query('query') ?? ''
        )
        return c.json({ suggestions })
    })
    return app
}
