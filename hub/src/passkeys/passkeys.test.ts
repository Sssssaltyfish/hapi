import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { createConfiguration } from '../configuration'
import { createPasskeyRoutes } from '../web/routes/passkeys'
import { createAuthRoutes } from '../web/routes/auth'
import { createAuthMiddleware, type WebAppEnv } from '../web/middleware/auth'
import { passkeyStore, verifyWebToken } from './config'
import { hashCode, PasskeyStore } from './store'

const previous = { home: process.env.HAPI_HOME, origin: process.env.HAPI_PASSKEY_ORIGIN }
const home = await mkdtemp(join(tmpdir(), 'hapi-passkey-test-'))
process.env.HAPI_HOME = home
process.env.HAPI_PASSKEY_ORIGIN = 'https://hapi.test'
await createConfiguration()
afterAll(async () => {
    passkeyStore().close()
    if (previous.home === undefined) delete process.env.HAPI_HOME; else process.env.HAPI_HOME = previous.home
    if (previous.origin === undefined) delete process.env.HAPI_PASSKEY_ORIGIN; else process.env.HAPI_PASSKEY_ORIGIN = previous.origin
    await rm(home, { recursive: true, force: true })
})

// Minimal test authenticator: real P-256 keys, CBOR attestation and DER signatures.
function cbor(value: unknown): Buffer {
    function head(type: number, n: number) {
        if (n < 24) return Buffer.from([type * 32 + n])
        if (n < 256) return Buffer.from([type * 32 + 24, n])
        return Buffer.from([type * 32 + 25, n >> 8, n & 255])
    }
    if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
    if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
    if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]) }
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object)
    return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)])])
}
const b64 = (value: Buffer) => value.toString('base64url')
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest()
function authenticator() {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicKey = keys.publicKey.export({ format: 'jwk' })
    const id = randomBytes(32)
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(publicKey.x!, 'base64url')], [-3, Buffer.from(publicKey.y!, 'base64url')]]))
    let counter = 0
    return {
        id: b64(id),
        registration(challenge: string, origin = 'https://hapi.test', uv = true) {
            const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }))
            const data = Buffer.concat([sha('hapi.test'), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose])
            return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {},
                response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(cbor({ fmt: 'none', attStmt: {}, authData: data })), transports: ['internal'] } }
        },
        assertion(challenge: string, userHandle: string, origin = 'https://hapi.test') {
            const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }))
            const count = Buffer.alloc(4); count.writeUInt32BE(++counter)
            const data = Buffer.concat([sha('hapi.test'), Buffer.from([5]), count])
            return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: {
                clientDataJSON: b64(clientDataJSON), authenticatorData: b64(data), userHandle,
                signature: b64(sign('sha256', Buffer.concat([data, sha(clientDataJSON)]), keys.privateKey)) } }
        }
    }
}

test('pair once, verify real WebAuthn signatures, reject bypasses/replays, and revoke sessions', async () => {
    const secret = randomBytes(32)
    const app = new Hono<WebAppEnv>()
    app.route('/api', createAuthRoutes(secret, {} as never))
    app.route('/api', createPasskeyRoutes(secret))
    app.use('/api/*', createAuthMiddleware(secret))
    app.get('/api/private', c => c.json({ ok: true }))
    const post = (path: string, body: unknown, origin = 'https://hapi.test', token?: string) => app.request(`/api/${path}`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    const store = passkeyStore()
    const key = authenticator()
    expect((await post('auth', { accessToken: 'machine-token' })).status).toBe(403)
    expect((await post('passkey/login/options', {}, 'https://evil.test')).status).toBe(403)
    expect((await post('passkey/register/options', { code: 'bad' })).status).toBe(401)
    const { code } = store.issueCode()
    const options: any = await (await post('passkey/register/options', { code })).json()
    const second: any = await (await post('passkey/register/options', { code })).json()
    const payload = { requestId: options.requestId, response: key.registration(options.options.challenge), name: 'Test device' }
    const registered = await post('passkey/register/verify', payload)
    expect(registered.status).toBe(200)
    const firstSession: any = await registered.json()
    expect(store.validPairing(hashCode(code))).toBe(false)
    expect((await post('passkey/register/verify', payload)).status).toBe(401)
    expect((await post('passkey/register/verify', { requestId: second.requestId, response: authenticator().registration(second.options.challenge) })).status).toBe(401)
    expect((await post('passkey/register/options', { code })).status).toBe(401)
    const oldJWT = await new SignJWT({ uid: 1, ns: 'default' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('4h').sign(secret)
    expect((await app.request('/api/private', { headers: { Authorization: `Bearer ${oldJWT}` } })).status).toBe(401)
    expect((await app.request('/api/private', { headers: { Authorization: `Bearer ${firstSession.token}` } })).status).toBe(200)
    const challenge: any = await (await post('passkey/login/options', {})).json()
    const loginPayload = { requestId: challenge.requestId, response: key.assertion(challenge.options.challenge, options.options.user.id) }
    const login = await post('passkey/login/verify', loginPayload)
    expect(login.status).toBe(200)
    const session: any = await login.json()
    expect((await post('passkey/login/verify', loginPayload)).status).toBe(401)
    const forged: any = await (await post('passkey/login/options', {})).json()
    const forgedResponse = key.assertion(forged.options.challenge, options.options.user.id)
    forgedResponse.response.signature = b64(randomBytes(72))
    expect((await post('passkey/login/verify', { requestId: forged.requestId, response: forgedResponse })).status).toBe(401)
    const wrongOrigin: any = await (await post('passkey/login/options', {})).json()
    expect((await post('passkey/login/verify', { requestId: wrongOrigin.requestId, response: key.assertion(wrongOrigin.options.challenge, options.options.user.id, 'https://evil.test') })).status).toBe(401)
    const noUV = store.issueCode()
    const uvOptions: any = await (await post('passkey/register/options', { code: noUV.code })).json()
    expect((await post('passkey/register/verify', { requestId: uvOptions.requestId, response: authenticator().registration(uvOptions.options.challenge, 'https://hapi.test', false) })).status).toBe(401)
    expect((await post('passkey/logout', {}, 'https://hapi.test', firstSession.token)).status).toBe(200)
    expect((await app.request('/api/private', { headers: { Authorization: `Bearer ${firstSession.token}` } })).status).toBe(401)
    expect((await verifyWebToken(session.token, secret)).payload.amr).toBe('passkey')
    store.revoke(key.id)
    await expect(verifyWebToken(session.token, secret)).rejects.toThrow()
})

test('expired codes/challenges and atomic code consumption fail closed', () => {
    const store = new PasskeyStore(':memory:')
    const expired = store.issueCode(Date.now() - 700_000)
    expect(store.validPairing(hashCode(expired.code))).toBe(false)
    const request = store.saveChallenge('nonce', 'login')
    store.db.query('UPDATE challenges SET expires = 0').run()
    expect(store.takeChallenge(request, 'login')).toBeNull()
    const code = store.issueCode().code
    const credential = { id: 'test', publicKey: new Uint8Array([1]), counter: 0 }
    store.register(hashCode(code), credential, 'test', 'user')
    expect(() => store.register(hashCode(code), { ...credential, id: 'second' }, 'test', 'user')).toThrow()
    store.close()
})
