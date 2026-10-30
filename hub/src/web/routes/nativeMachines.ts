import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { NativeEndpointConfig, NativeRegistry } from '../../codexNative/registry'
import type { NativeService } from '../../codexNative/service'
import { nativeAddressSchema, nativeDisplayNameSchema, nativeMachineError } from '../../codexNative/machineSettings'

const createSchema = z.object({
    address: nativeAddressSchema,
    displayName: nativeDisplayNameSchema.optional(),
    token: z.string().optional(),
    defaultCwd: z.string().min(1).max(4096).optional()
}).strict()
const renameSchema = z.object({ displayName: nativeDisplayNameSchema }).strict()

export async function nativeMachineStatus(endpoint: { config: NativeEndpointConfig; service: NativeService }) {
    try {
        const initialization = await endpoint.service.withConnection(async client => client.initialization)
        const fact = (name: string) => typeof initialization[name] === 'string' ? initialization[name] as string : undefined
        return {
            enabled: true,
            available: true,
            platformOs: fact('platformOs'),
            platformFamily: fact('platformFamily'),
            codexHome: fact('codexHome'),
            userAgent: fact('userAgent')
        }
    } catch (error) {
        return { enabled: true, available: false, error: nativeMachineError(error, endpoint.config) }
    }
}

export function createNativeMachinesRoutes(registry: NativeRegistry): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.onError((error, c) => c.json(
        { error: error.message },
        /already configured|limit reached/.test(error.message) ? 409 : 500
    ))
    app.get('/codex-native/endpoints', async c => {
        await registry.refresh()
        return c.json({ endpoints: registry.visible(c.get('namespace')).map(({ config }) => registry.summary(config)) })
    })
    app.post('/codex-native/endpoints', async c => {
        const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid native machine configuration' }, 400)
        const endpoint = await registry.add(c.get('namespace'), parsed.data)
        return c.json({ endpoint }, 201)
    })
    app.patch('/codex-native/endpoints/:endpointId', async c => {
        const parsed = renameSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid native machine display name' }, 400)
        const endpoint = await registry.rename(c.get('namespace'), c.req.param('endpointId'), parsed.data.displayName)
        return endpoint ? c.json({ endpoint }) : c.json({ error: 'Native machine not found' }, 404)
    })
    app.get('/codex-native/endpoints/:endpointId/status', async c => {
        await registry.refresh()
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))
        if (!endpoint) return c.json({ error: 'Native machine not found' }, 404)
        return c.json(await nativeMachineStatus(endpoint))
    })
    return app
}
