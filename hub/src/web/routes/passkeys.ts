import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { SignJWT } from 'jose'
import { randomBytes } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse,
    verifyRegistrationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON,
    type AuthenticatorTransport } from '@simplewebauthn/server'
import { passkeyConfig, passkeyStore, verifyWebToken } from '../../passkeys/config'
import { hashCode } from '../../passkeys/store'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'

export function createPasskeyRoutes(jwtSecret: Uint8Array) {
    const app = new Hono<WebAppEnv>()
    const config = passkeyConfig()
    app.get('/passkey/config', c => {
        c.header('Cache-Control', 'no-store')
        return c.json({ enabled: !!config })
    })
    if (!config) return app
    const store = passkeyStore()
    let windowStart = 0
    let attempts = 0
    app.use('/passkey/*', bodyLimit({ maxSize: 32 * 1024 }))
    app.use('/passkey/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (c.req.method === 'POST') {
            if (c.req.header('Origin') !== config.origin) return c.json({ error: 'Invalid origin' }, 403)
            if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
            if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); attempts = 0 }
            if (++attempts > 60) return c.json({ error: 'Too many attempts. Try again in a minute.' }, 429)
        }
        return next()
    })
    const authenticate = async (credentialId: string) => {
        const uid = await getOrCreateOwnerId()
        const session = store.createSession(credentialId)
        const token = await new SignJWT({ uid, ns: 'default', amr: 'passkey', sid: session.id })
            .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(Math.floor(session.expiresAt / 1000)).sign(jwtSecret)
        return { token, user: { id: uid, firstName: 'HAPI Owner' }, expiresAt: session.expiresAt }
    }
    app.post('/passkey/register/options', async c => {
        const body = await c.req.json().catch(() => null)
        if (typeof body?.code !== 'string' || body.code.length > 100 || !store.validPairing(hashCode(body.code))) {
            return c.json({ error: '配对码无效、已使用或已过期。' }, 401)
        }
        const userID = config.sharedUserId ? Buffer.from(config.sharedUserId) : randomBytes(32)
        const options = await generateRegistrationOptions({ rpName: config.sharedUserId ? 'Seia' : 'HAPI', rpID: config.rpID,
            userID, userName: 'HAPI Owner', attestationType: 'none',
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            supportedAlgorithmIDs: [-7, -257],
            excludeCredentials: store.credentials().map(key => ({ id: key.id })) })
        const requestId = store.saveChallenge(options.challenge, 'register', hashCode(body.code), options.user.id)
        return c.json({ options, requestId })
    })
    app.post('/passkey/register/verify', async c => {
        const body = await c.req.json().catch(() => null)
        if (typeof body?.requestId !== 'string' || !body?.response) return c.json({ error: 'Invalid request' }, 400)
        const challenge = store.takeChallenge(body.requestId, 'register')
        if (!challenge?.pairingHash || !challenge.userHandle || !store.validPairing(challenge.pairingHash)) return c.json({ error: '配对请求已过期，请重新开始。' }, 401)
        try {
            const result = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON,
                expectedChallenge: challenge.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID,
                requireUserVerification: true })
            if (!result.verified || !result.registrationInfo) throw new Error('Invalid registration')
            const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
            store.register(challenge.pairingHash, result.registrationInfo.credential, name || 'Passkey', challenge.userHandle,
                { deviceType: result.registrationInfo.credentialDeviceType, backedUp: result.registrationInfo.credentialBackedUp })
            return c.json(await authenticate(result.registrationInfo.credential.id))
        } catch { return c.json({ error: 'Passkey 注册验证失败，请重新开始。' }, 401) }
    })
    app.post('/passkey/login/options', async c => {
        // Discoverable credentials avoid publishing a list of credential IDs.
        const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' })
        return c.json({ options, requestId: store.saveChallenge(options.challenge, 'login') })
    })
    app.post('/passkey/login/verify', async c => {
        const body = await c.req.json().catch(() => null)
        if (typeof body?.requestId !== 'string' || typeof body?.response?.id !== 'string') return c.json({ error: 'Invalid request' }, 400)
        const challenge = store.takeChallenge(body.requestId, 'login')
        const credential = store.credential(body.response.id)
        if (!challenge || !credential) return c.json({ error: 'Passkey 无效或登录请求已过期。' }, 401)
        try {
            const response = body.response as AuthenticationResponseJSON
            if (response.response.userHandle !== credential.userHandle) throw new Error('Wrong account')
            const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
                expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true,
                credential: { id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.key, 'base64url')),
                    counter: credential.counter, transports: JSON.parse(credential.transports) as AuthenticatorTransport[] } })
            if (!result.verified || !store.updateCounter(credential.id, credential.counter, result.authenticationInfo.newCounter)) throw new Error('Invalid authentication')
            return c.json(await authenticate(credential.id))
        } catch { return c.json({ error: 'Passkey 登录验证失败，请重试。' }, 401) }
    })
    app.get('/passkey/session', async c => {
        try {
            const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? ''
            const { payload } = await verifyWebToken(token, jwtSecret)
            return c.json({ token, user: { id: payload.uid as number, firstName: 'HAPI Owner' }, expiresAt: payload.exp! * 1000 })
        } catch { return c.json({ error: '请使用 Passkey 登录。' }, 401) }
    })
    app.post('/passkey/logout', async c => {
        try {
            const { payload } = await verifyWebToken(c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '', jwtSecret)
            store.logout(payload.sid as string)
        } catch { /* Already expired or logged out. */ }
        return c.json({ ok: true })
    })
    return app
}
