import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { SignJWT } from 'jose'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { verifyWebToken } from '../../passkeys/config'
import { exchangeExternalCookie, ExternalAuthError, logoutExternalSession, type ExternalAuthConfig } from '../../passkeys/external'
import type { WebAppEnv } from '../middleware/auth'

export function createExternalAuthRoutes(jwtSecret: Uint8Array, config: ExternalAuthConfig): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('/passkey/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (c.req.method === 'POST' && c.req.header('Origin') !== config.origin) return c.json({ error: 'Invalid origin' }, 403)
        return next()
    })
    app.get('/passkey/config', c => c.json({ enabled: true, externalLoginUrl: config.loginUrl }))
    app.get('/passkey/session', async c => {
        try {
            const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '')
            if (bearer) {
                const { payload } = await verifyWebToken(bearer, jwtSecret)
                return c.json({ token: bearer, user: { id: payload.uid as number, firstName: 'HAPI Owner' }, expiresAt: payload.exp! * 1000 })
            }
            const external = await exchangeExternalCookie(config, c.req.header('Cookie') ?? '')
            const uid = await getOrCreateOwnerId()
            const expiresAt = Math.min(external.expiresAt, Date.now() + 4 * 60 * 60_000)
            const token = await new SignJWT({ uid, ns: config.namespace, amr: 'external-passkey', sid: external.sessionId })
                .setSubject(external.subject).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
                .setExpirationTime(Math.floor(expiresAt / 1000)).sign(jwtSecret)
            return c.json({ token, user: { id: uid, firstName: 'HAPI Owner' }, expiresAt })
        } catch (error) {
            const status = error instanceof ExternalAuthError ? error.status : 401
            return c.json({ error: status === 503 ? '认证服务暂时不可用，请稍后重试。' : '请通过共享认证入口登录。' }, status)
        }
    })
    app.post('/passkey/logout', async c => {
        try {
            const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '')
            const sessionId = bearer
                ? (await verifyWebToken(bearer, jwtSecret)).payload.sid as string
                : (await exchangeExternalCookie(config, c.req.header('Cookie') ?? '')).sessionId
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
    app.post('/passkey/*', c => c.json({ error: '请通过共享认证入口登录或注册。', externalLoginUrl: config.loginUrl }, 403))
    return app
}
