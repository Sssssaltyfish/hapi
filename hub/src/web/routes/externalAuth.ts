import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { SignJWT, jwtVerify } from 'jose'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { verifyWebToken } from '../../passkeys/config'
import { exchangeExternalCookie, ExternalAuthError, externalPasskeyRequest, parseExternalSession,
    logoutExternalSession, requireExternalSession, type ExternalAuthConfig, type ExternalSession } from '../../passkeys/external'
import type { WebAppEnv } from '../middleware/auth'

export function createExternalAuthRoutes(jwtSecret: Uint8Array, config: ExternalAuthConfig): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('/passkey/*', bodyLimit({ maxSize: 32 * 1024 }))
    app.use('/passkey/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (c.req.method === 'POST') {
            if (c.req.header('Origin') !== config.origin) return c.json({ error: 'Invalid origin' }, 403)
            if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
        }
        return next()
    })
    const authenticate = async (external: ExternalSession) => {
        const uid = await getOrCreateOwnerId()
        const expiresAt = Math.min(external.expiresAt, Date.now() + 30 * 60_000)
        const token = await new SignJWT({ uid, ns: config.namespace, amr: 'external-passkey', sid: external.sessionId })
            .setSubject(external.subject).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
            .setExpirationTime(Math.floor(expiresAt / 1000)).sign(jwtSecret)
        return { token, user: { id: uid, firstName: 'HAPI Owner' }, expiresAt }
    }
    app.get('/passkey/config', c => c.json({ enabled: true, sharedSession: true }))
    for (const action of ['register/options', 'register/verify', 'login/options', 'login/verify']) {
        app.post(`/passkey/${action}`, async c => {
            const body = await c.req.json().catch(() => null)
            if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid request' }, 400)
            try {
                const response = await externalPasskeyRequest(config, action, body, c.req.header('Origin')!)
                const result: unknown = await response.json()
                if (!response.ok) {
                    const status = response.status
                    if (status !== 400 && status !== 401 && status !== 403 && status !== 413 && status !== 415 && status !== 429) {
                        throw new ExternalAuthError(503)
                    }
                    const error = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
                        ? result.error : 'Passkey 验证失败，请重试。'
                    return c.json({ error }, status)
                }
                if (action.endsWith('/options')) return c.json(result as Record<string, unknown>)
                const session = parseExternalSession(config, result)
                const cookie = response.headers.get('Set-Cookie')
                if (!cookie?.startsWith('__Host-seia_session=') || !cookie.includes('HttpOnly') || !cookie.includes('Secure')) {
                    throw new ExternalAuthError(503)
                }
                const authenticated = await authenticate(session)
                c.header('Set-Cookie', cookie)
                return c.json(authenticated)
            } catch (error) {
                const status = error instanceof ExternalAuthError ? error.status : 503
                return c.json({ error: status === 503 ? '认证服务暂时不可用，请稍后重试。' : 'Passkey 验证失败，请重试。' }, status)
            }
        })
    }
    app.get('/passkey/session', async c => {
        try {
            // The persistent HttpOnly session remains usable after a browser sleeps past JWT expiry.
            if (getCookie(c, '__Host-seia_session')) {
                return c.json(await authenticate(await exchangeExternalCookie(config, c.req.header('Cookie') ?? '')))
            }
            const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '')
            if (bearer) {
                const { payload } = await jwtVerify(bearer, jwtSecret, { algorithms: ['HS256'] })
                return c.json(await authenticate(await requireExternalSession(config, payload)))
            }
            const external = await exchangeExternalCookie(config, c.req.header('Cookie') ?? '')
            return c.json(await authenticate(external))
        } catch (error) {
            const status = error instanceof ExternalAuthError ? error.status : 401
            return c.json({ error: status === 503 ? '认证服务暂时不可用，请稍后重试。' : '请使用 Passkey 登录。' }, status)
        }
    })
    app.post('/passkey/logout', async c => {
        try {
            const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '')
            const sessionId = getCookie(c, '__Host-seia_session')
                ? (await exchangeExternalCookie(config, c.req.header('Cookie') ?? '')).sessionId
                : (await verifyWebToken(bearer ?? '', jwtSecret)).payload.sid as string
            await logoutExternalSession(config, sessionId)
        } catch (error) {
            if (error instanceof ExternalAuthError && error.status === 503) {
                return c.json({ error: '认证服务暂时不可用，尚未退出，请重试。' }, 503)
            }
            // Expired or revoked sessions already have no authority.
        }
        deleteCookie(c, '__Host-seia_session', { secure: true, httpOnly: true, sameSite: 'Lax', path: '/' })
        return c.json({ ok: true })
    })
    return app
}
