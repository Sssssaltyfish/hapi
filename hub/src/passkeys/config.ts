import { join } from 'node:path'
import { homedir } from 'node:os'
import { jwtVerify, type JWTPayload } from 'jose'
import { PasskeyStore } from './store'
import { externalAuthConfig, requireExternalSession } from './external'

export function passkeyConfig() {
    const value = process.env.HAPI_PASSKEY_ORIGIN
    if (!value) return null
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('HAPI_PASSKEY_ORIGIN must be an HTTPS origin')
    }
    return { origin: url.origin, rpID: url.hostname,
        sharedUserId: process.env.HAPI_PASSKEY_SHARED_USER_ID,
        dbPath: process.env.SEIA_PASSKEY_DB || join(process.env.HAPI_HOME || join(homedir(), '.hapi'), 'passkeys.sqlite') }
}
let singleton: { path: string; store: PasskeyStore } | undefined
export function passkeyStore() {
    const config = passkeyConfig()
    if (!config) throw new Error('Passkey authentication is disabled')
    if (!singleton || singleton.path !== config.dbPath) {
        singleton?.store.close()
        if (process.env.SEIA_PASSKEY_DB && !config.sharedUserId) throw new Error('Shared Passkeys require an explicit account mapping')
        singleton = { path: config.dbPath, store: new PasskeyStore(config.dbPath, config.sharedUserId) }
    }
    return singleton.store
}
export function requirePasskeySession(payload: JWTPayload) {
    if (!passkeyConfig()) return
    if (payload.amr !== 'passkey' || typeof payload.sid !== 'string' || !passkeyStore().hasSession(payload.sid)) {
        throw new Error('Passkey login required')
    }
}
export async function verifyWebToken(token: string, secret: Uint8Array) {
    const result = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    const external = externalAuthConfig()
    if (external) await requireExternalSession(external, result.payload)
    else requirePasskeySession(result.payload)
    return result
}
