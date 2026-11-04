import type { MiddlewareHandler } from 'hono'
import type { WebAppEnv } from '../web/middleware/auth'
import type { SyncEngine } from '../sync/syncEngine'
import { NativeRegistry, parseNativeSessionId } from './registry'
import { record } from './transport'

/** Old session URLs remain identities; no legacy storage or harness endpoint may
 * consume a native identity, including when its daemon is unavailable. */
export function nativeSessionMiddleware(
    registry: NativeRegistry,
    getEngine: () => SyncEngine | null
): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        await registry.refresh()
        const match = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(c.req.path)
        if (!match) return next()
        const id = decodeURIComponent(match[1]),
            namespace = c.get('namespace'),
            parsed = parseNativeSessionId(id)
        const access = getEngine()?.resolveSessionAccess(id, namespace)
        const binding = parsed
            ? { endpoint: registry.get(namespace, parsed.endpointId), threadId: parsed.threadId }
            : access?.ok
              ? registry.alias(access.session, namespace)
              : undefined
        if (parsed && !binding?.endpoint) return c.json({ error: 'Native session not found' }, 404)
        const marked = access?.ok && access.session.metadata?.nativeCodex
        if (binding?.endpoint && !match[2] && c.req.method === 'PATCH') {
            const body = record(await c.req.json())
            if (
                typeof body.name !== 'string' ||
                !body.name.trim() ||
                body.name.length > 500 ||
                Object.keys(body).length !== 1
            )
                return c.json({ error: 'Invalid native session name' }, 400)
            await binding.endpoint.service.control(binding.threadId, 'thread/name/set', {
                name: body.name,
            })
            return c.json({ success: true })
        }
        if (binding?.endpoint && match[2] === '/archive' && c.req.method === 'POST') {
            await binding.endpoint.service.control(binding.threadId, 'thread/archive', {})
            await registry.observeCatalogEvent(c.get('namespace'), binding.endpoint.config.id, {
                method: 'thread/archived', params: { threadId: binding.threadId },
            })
            return c.json({ success: true })
        }
        if ((binding?.endpoint || marked) && (match[2] || c.req.method !== 'GET'))
            return c.json(
                {
                    error: 'This native Codex session uses daemon controls',
                    code: 'native_session_direct_api',
                },
                409
            )
        return next()
    }
}
