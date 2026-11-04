import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import type { NativeRegistry } from '../../codexNative/registry'
import { nativeSessionId } from '../../codexNative/registry'
import { record } from '../../codexNative/transport'
import { z } from 'zod'
import { threadReferenceCapability } from '../../codexNative/mentions'

export function createNativeMentionsRoutes(registry: NativeRegistry): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/codex-native/thread-reference', async (c) => {
        const parsed = z.object({
            threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,500}$/),
            hostId: z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/).optional(),
            targetEndpointId: z.string().min(1).max(80).optional(),
            endpointId: z.string().min(1).max(80).optional(),
        }).strict().safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid Codex thread reference' }, 400)
        await registry.refresh()
        const { threadId, hostId, targetEndpointId, endpointId } = parsed.data
        let candidates = registry.visible(c.get('namespace'))
        if (targetEndpointId) candidates = candidates.filter(endpoint => endpoint.config.id === targetEndpointId)
        else if (!hostId) candidates = endpointId ? candidates.filter(endpoint => endpoint.config.id === endpointId) : []
        if (hostId) candidates = candidates.filter(endpoint => endpoint.config.desktopHostId === hostId)
        if (!candidates.length) return c.json({ error: 'The Codex host for this reference is not configured' }, 404)
        if (candidates.length !== 1) return c.json({ error: 'This Codex host maps to more than one connection' }, 409)
        const endpoint = candidates[0]
        if (endpoint.config.desktopHostId && registry.visible(c.get('namespace')).filter(candidate => candidate.config.desktopHostId === endpoint.config.desktopHostId).length !== 1) {
            return c.json({ error: 'This Codex host maps to more than one connection' }, 409)
        }
        const response = record(await endpoint.service.readThread(threadId))
        const thread = record(response.thread)
        if (thread.id !== threadId) return c.json({ error: 'Referenced Codex chat is no longer available' }, 404)
        return c.json({
            sessionId: nativeSessionId(endpoint.config.id, threadId),
            endpointId: endpoint.config.id,
            threadId,
            hostId: endpoint.config.desktopHostId ?? null,
        })
    })
    app.get('/codex-native/threads/:id/suggestions', async (c) => {
        const endpoint = registry.get(c.get('namespace'), c.req.query('endpointId'))
        if (!endpoint) return c.json({ error: 'Native endpoint not found' }, 404)
        const [suggestions, canReferenceThreads] = await Promise.all([endpoint.service.suggestions(
            c.req.param('id'),
            c.req.query('query') ?? ''
        ), threadReferenceCapability(endpoint.service, c.req.param('id'))])
        return c.json({ suggestions, canReferenceThreads })
    })
    app.get('/codex-native/threads/:id/reference-capabilities', async (c) => {
        const endpoint = registry.get(c.get('namespace'), c.req.query('endpointId'))
        if (!endpoint) return c.json({ error: 'Native endpoint not found' }, 404)
        return c.json({ readThread: await threadReferenceCapability(endpoint.service, c.req.param('id')) })
    })
    return app
}
