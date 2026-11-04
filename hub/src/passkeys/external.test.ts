import { afterAll, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SignJWT, type JWTPayload } from 'jose'
import { createConfiguration } from '../configuration'
import { verifyWebToken } from './config'
import { createPasskeyRoutes } from '../web/routes/passkeys'
import { createAuthRoutes } from '../web/routes/auth'
import { Hono } from 'hono'
import { createAuthMiddleware } from '../web/middleware/auth'

const home = await mkdtemp(join(tmpdir(), 'hapi-external-auth-'))
const env = ['HAPI_HOME', 'HAPI_PASSKEY_ORIGIN', 'HAPI_EXTERNAL_AUTH_URL', 'HAPI_EXTERNAL_AUTH_LOGIN_URL',
    'HAPI_EXTERNAL_AUTH_ORIGIN', 'HAPI_EXTERNAL_AUTH_SUBJECT', 'HAPI_EXTERNAL_AUTH_TOKEN', 'HAPI_EXTERNAL_AUTH_NAMESPACE']
const previous = Object.fromEntries(env.map(key => [key, process.env[key]]))
const serviceToken = randomBytes(32).toString('base64url')
const sessionId = 'a'.repeat(64)
let active = true
let available = true
let issuerExpiresAt = Date.now() + 60_000
const issuer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (!available) return new Response(null, { status: 503 })
    if (request.headers.get('Authorization') !== `Bearer ${serviceToken}`) return new Response(null, { status: 401 })
    const action = new URL(request.url).pathname.split('/').pop()
    if (new URL(request.url).pathname.includes('/passkey/')) {
        if (request.headers.get('Origin') !== 'https://seia.test:8444') return new Response(null, { status: 403 })
        if (action === 'options') return Response.json({ options: { challenge: 'nonce' }, requestId: 'request' })
        return Response.json({ subject: 'owner', sessionId, expiresAt: issuerExpiresAt }, {
            headers: { 'Set-Cookie': '__Host-seia_session=test; Path=/; Secure; HttpOnly; SameSite=Lax' }
        })
    }
    if (action === 'logout') { active = false; return Response.json({ ok: true }) }
    if (!active) return new Response(null, { status: 401 })
    if (action === 'session' && request.headers.get('Cookie') !== '__Host-seia_session=test') return new Response(null, { status: 401 })
    if (action === 'introspect' && (await request.json() as { sessionId: string }).sessionId !== sessionId) return new Response(null, { status: 401 })
    return Response.json({ subject: 'owner', sessionId, expiresAt: issuerExpiresAt })
} })
process.env.HAPI_HOME = home
delete process.env.HAPI_PASSKEY_ORIGIN
process.env.HAPI_EXTERNAL_AUTH_URL = `http://127.0.0.1:${issuer.port}`
process.env.HAPI_EXTERNAL_AUTH_LOGIN_URL = 'https://seia.test/auth/?app=hapi'
process.env.HAPI_EXTERNAL_AUTH_ORIGIN = 'https://seia.test:8444'
process.env.HAPI_EXTERNAL_AUTH_SUBJECT = 'owner'
process.env.HAPI_EXTERNAL_AUTH_TOKEN = serviceToken
process.env.HAPI_EXTERNAL_AUTH_NAMESPACE = 'default'
await createConfiguration()
afterAll(async () => {
    issuer.stop(true)
    for (const key of env) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
    }
    await rm(home, { recursive: true, force: true })
})

test('persistent cookie renews short JWT after browser sleep and wins over an expired bearer', async () => {
    active = true; available = true; issuerExpiresAt = Date.now() + 30 * 24 * 60 * 60_000
    const secret = randomBytes(32), app = new Hono()
    app.route('/api',createPasskeyRoutes(secret))
    const expired = await new SignJWT({uid:1,ns:'default',sub:'owner',amr:'external-passkey',sid:sessionId})
        .setProtectedHeader({alg:'HS256'}).setExpirationTime(Math.floor(Date.now()/1000)-3600).sign(secret)
    const headers = {Authorization:`Bearer ${expired}`,Cookie:'__Host-seia_session=test'}
    expect((await app.request('/api/passkey/session',{headers:{Authorization:headers.Authorization}})).status).toBe(401)
    const renewed = await app.request('/api/passkey/session',{headers})
    expect(renewed.status).toBe(200)
    const auth = await renewed.json() as {token:string;expiresAt:number}
    const verified = await verifyWebToken(auth.token,secret)
    expect(verified.payload.sid).toBe(sessionId)
    expect(auth.expiresAt-Date.now()).toBeGreaterThan(29*60_000)
    expect(auth.expiresAt-Date.now()).toBeLessThanOrEqual(30*60_000)
    const short = await new SignJWT({uid:1,ns:'default',sub:'owner',amr:'external-passkey',sid:sessionId})
        .setProtectedHeader({alg:'HS256'}).setExpirationTime(Math.floor(Date.now()/1000)+120).sign(secret)
    const bearerRenewal = await app.request('/api/passkey/session',{headers:{Authorization:`Bearer ${short}`}})
    expect((await bearerRenewal.json() as {expiresAt:number}).expiresAt-Date.now()).toBeGreaterThan(29*60_000)
    const logout = await app.request('/api/passkey/logout',{method:'POST',headers:{...headers,Origin:'https://seia.test:8444','Content-Type':'application/json'},body:'{}'})
    expect(logout.status).toBe(200)
    expect((await app.request('/api/passkey/session',{headers})).status).toBe(401)
    await expect(verifyWebToken(auth.token,secret)).rejects.toThrow()
})

test('central cookie exchange preserves app JWT, rejects bypasses and follows revocation/outages', async () => {
    active = true; available = true; issuerExpiresAt = Date.now() + 60_000
    const secret = randomBytes(32)
    const app = new Hono()
    app.route('/api', createAuthRoutes(secret, {} as never))
    app.route('/api', createPasskeyRoutes(secret))
    app.use('/api/*', createAuthMiddleware(secret))
    app.get('/api/private', c => c.json({ ok: true }))
    const config = await (await app.request('/api/passkey/config')).json()
    expect(config).toEqual({ enabled: true, sharedSession: true })
    expect((await app.request('/api/passkey/session')).status).toBe(401)
    expect((await app.request('/api/auth', { method: 'POST', body: '{}' })).status).toBe(403)
    const postHeaders = { Origin: 'https://seia.test:8444', 'Content-Type': 'application/json' }
    expect((await app.request('/api/passkey/login/options', { method: 'POST', headers: { ...postHeaders, Origin: 'https://evil.test' }, body: '{}' })).status).toBe(403)
    const options = await app.request('/api/passkey/login/options', { method: 'POST', headers: postHeaders, body: '{}' })
    expect(options.status).toBe(200)
    expect(await options.json()).toEqual({ options: { challenge: 'nonce' }, requestId: 'request' })
    const login = await app.request('/api/passkey/login/verify', { method: 'POST', headers: postHeaders, body: '{}' })
    expect(login.headers.get('set-cookie')).toContain('__Host-seia_session=test')
    const logged = await login.json() as { token: string; sessionId?: string }
    expect(logged.sessionId).toBeUndefined()
    expect((await verifyWebToken(logged.token, secret)).payload.ns).toBe('default')
    const response = await app.request('/api/passkey/session', { headers: { Cookie: '__Host-seia_session=test' } })
    expect(response.status).toBe(200)
    const auth = await response.json() as { token: string }
    const verified = await verifyWebToken(auth.token, secret)
    expect(verified.payload.amr).toBe('external-passkey')
    expect(verified.payload.ns).toBe('default')
    expect(verified.payload.sid).toBe(sessionId)
    const headers = { Authorization: `Bearer ${auth.token}` }
    expect((await app.request('/api/private', { headers })).status).toBe(200)
    const token = (payload: JWTPayload) => new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)
    await expect(verifyWebToken(await token({ uid: 1, ns: 'default', amr: 'passkey', sid: sessionId }), secret)).rejects.toThrow()
    await expect(verifyWebToken(await token({ uid: 1, ns: 'other', sub: 'owner', amr: 'external-passkey', sid: sessionId }), secret)).rejects.toThrow()
    await expect(verifyWebToken(await token({ uid: 1, ns: 'default', sub: 'other', amr: 'external-passkey', sid: sessionId }), secret)).rejects.toThrow()
    available = false
    expect((await app.request('/api/private', { headers })).status).toBe(401)
    expect((await app.request('/api/passkey/session', { headers })).status).toBe(503)
    expect((await app.request('/api/passkey/logout', { method: 'POST', headers: { ...headers, ...postHeaders } })).status).toBe(503)
    available = true
    expect((await app.request('/api/passkey/logout', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } })).status).toBe(403)
    const logout = await app.request('/api/passkey/logout', { method: 'POST', headers: { ...headers, ...postHeaders } })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('__Host-seia_session=')
    expect((await app.request('/api/private', { headers })).status).toBe(401)
})
