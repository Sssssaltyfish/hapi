import type { JWTPayload } from 'jose'
import { z } from 'zod'

export type ExternalAuthConfig = {
    url: string
    origin: string
    subject: string
    token: string
    namespace: string
}

const sessionSchema = z.object({
    subject: z.string().min(1),
    sessionId: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive()
})
export type ExternalSession = z.infer<typeof sessionSchema>

export class ExternalAuthError extends Error {
    constructor(readonly status: 401 | 503) {
        super(status === 401 ? 'External authentication required' : 'External authentication unavailable')
    }
}

export function externalAuthConfig(): ExternalAuthConfig | null {
    const value = process.env.HAPI_EXTERNAL_AUTH_URL
    if (!value) return null
    const endpoint = new URL(value)
    const origin = new URL(process.env.HAPI_EXTERNAL_AUTH_ORIGIN ?? '')
    const subject = process.env.HAPI_EXTERNAL_AUTH_SUBJECT
    const token = process.env.HAPI_EXTERNAL_AUTH_TOKEN
    const namespace = process.env.HAPI_EXTERNAL_AUTH_NAMESPACE ?? 'default'
    const localHttp = endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    if ((!localHttp && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
        || origin.protocol !== 'https:' || origin.origin !== process.env.HAPI_EXTERNAL_AUTH_ORIGIN
        || !subject || !token || token.length < 32) {
        throw new Error('Invalid external authentication configuration')
    }
    return { url: endpoint.origin, origin: origin.origin, subject, token, namespace }
}

async function callIssuer(config: ExternalAuthConfig, action: string, body: object, headers: Record<string, string> = {}): Promise<Response> {
    try {
        return await fetch(`${config.url}/internal/hapi/${action}`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(3_000),
            headers: {
                Authorization: `Bearer ${config.token}`,
                'Content-Type': 'application/json',
                ...headers
            },
            body: JSON.stringify(body)
        })
    } catch (error) {
        if (error instanceof ExternalAuthError) throw error
        throw new ExternalAuthError(503)
    }
}

async function request(config: ExternalAuthConfig, action: string, body: object, cookie?: string): Promise<unknown> {
    const response = await callIssuer(config, action, body, cookie ? { Cookie: cookie } : {})
    if (response.status === 401) throw new ExternalAuthError(401)
    if (!response.ok) throw new ExternalAuthError(503)
    try { return await response.json() } catch { throw new ExternalAuthError(503) }
}

export function externalPasskeyRequest(config: ExternalAuthConfig, action: string, body: object, origin: string): Promise<Response> {
    return callIssuer(config, `passkey/${action}`, body, { Origin: origin })
}

export function parseExternalSession(config: ExternalAuthConfig, value: unknown): ExternalSession {
    const parsed = sessionSchema.safeParse(value)
    if (!parsed.success || parsed.data.subject !== config.subject || parsed.data.expiresAt <= Date.now()) {
        throw new ExternalAuthError(401)
    }
    return parsed.data
}

export async function exchangeExternalCookie(config: ExternalAuthConfig, cookie: string): Promise<ExternalSession> {
    if (!cookie) throw new ExternalAuthError(401)
    return parseExternalSession(config, await request(config, 'session', {}, cookie))
}

export async function requireExternalSession(config: ExternalAuthConfig, payload: JWTPayload): Promise<ExternalSession> {
    if (payload.amr !== 'external-passkey' || payload.sub !== config.subject || payload.ns !== config.namespace
        || typeof payload.sid !== 'string' || !/^[a-f0-9]{64}$/.test(payload.sid)) {
        throw new ExternalAuthError(401)
    }
    const verified = parseExternalSession(config, await request(config, 'introspect', { sessionId: payload.sid }))
    if (verified.sessionId !== payload.sid) throw new ExternalAuthError(401)
    return verified
}

export async function logoutExternalSession(config: ExternalAuthConfig, sessionId: string): Promise<void> {
    const result = await request(config, 'logout', { sessionId })
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new ExternalAuthError(503)
}
