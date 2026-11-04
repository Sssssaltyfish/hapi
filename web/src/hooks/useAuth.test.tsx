import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the network layer so we can drive token refreshes deterministically.
// The real ApiClient reads the live token via `getToken`, so the mock records the
// constructor options (including onUnauthorized) and hands out incrementing tokens.
const h = vi.hoisted(() => {
    let idSeq = 0
    let authCount = 0
    class MockApiClient {
        token: string
        options: { getToken?: () => string | null; onUnauthorized?: () => unknown; baseUrl?: string } | undefined
        readonly id: number
        constructor(token: string, options?: MockApiClient['options']) {
            this.token = token
            this.options = options
            this.id = ++idSeq
        }
        async authenticate(): Promise<{ token: string; user: { id: string } }> {
            authCount += 1
            return { token: `token-${authCount}`, user: { id: 'u1' } }
        }
    }
    class MockApiError extends Error {
        status: number
        code?: string
        constructor(message: string, status = 401, code?: string) {
            super(message)
            this.status = status
            this.code = code
        }
    }
    return { MockApiClient, MockApiError }
})

vi.mock('@/api/client', () => ({ ApiClient: h.MockApiClient, ApiError: h.MockApiError }))

// Imported after the mock is registered (vi.mock is hoisted).
import { useAuth } from '@/hooks/useAuth'

type ApiWithOptions = {
    id: number
    options?: { getToken?: () => string | null; onUnauthorized?: () => unknown }
}

afterEach(() => vi.unstubAllGlobals())

describe('Passkey refresh', () => {
    it('includes the persistent cookie and uses the latest JWT for successive refreshes', async () => {
        let sequence = 0
        const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({token:`passkey-${++sequence}`,user:{id:'u1'}}))
        vi.stubGlobal('fetch',fetcher)
        const source = {type:'passkey' as const,token:'initial'}
        const {result} = renderHook(() => useAuth(source,'https://hub.test'))
        await waitFor(() => expect(result.current.token).toBe('passkey-1'))
        const api = result.current.api as unknown as ApiWithOptions
        await act(async () => { await api.options?.onUnauthorized?.() })
        await act(async () => { await api.options?.onUnauthorized?.() })
        expect(result.current.token).toBe('passkey-3')
        expect(fetcher.mock.calls.map(call => (call[1] as RequestInit).headers)).toEqual([
            {Authorization:'Bearer initial'}, {Authorization:'Bearer passkey-1'}, {Authorization:'Bearer passkey-2'}
        ])
        expect(fetcher.mock.calls.every(call => (call[1] as RequestInit).credentials === 'include')).toBe(true)
        expect(result.current.api).toBe(api as unknown as typeof result.current.api)
    })
    it('keeps the current session through issuer outages and rejects a revoked session', async () => {
        let status = 200
        vi.stubGlobal('fetch',vi.fn(async () => status === 200
            ? Response.json({token:'current',user:{id:'u1'}}) : new Response('{}',{status})))
        const source = {type:'passkey' as const,token:'initial'}
        const {result} = renderHook(() => useAuth(source,'https://hub.test'))
        await waitFor(() => expect(result.current.token).toBe('current'))
        const api = result.current.api as unknown as ApiWithOptions
        status = 503
        await act(async () => { await api.options?.onUnauthorized?.() })
        expect(result.current.token).toBe('current')
        status = 401
        await act(async () => { await api.options?.onUnauthorized?.() })
        expect(result.current.token).toBeNull()
    })
})

describe('useAuth — api identity stability across token refresh (issue #927)', () => {
    it('keeps the same ApiClient instance when the token refreshes', async () => {
        // Stable authSource reference, exactly like the real caller (useAuthSource holds it in
        // useState). This isolates the bug under test: a *token* refresh, not a source change.
        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))

        // Initial authenticate resolves and sets the first token.
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const api1 = result.current.api as unknown as ApiWithOptions
        const token1 = result.current.token
        expect(token1).toBe('token-1')

        // Drive the exact real-world trigger: a 401 invokes onUnauthorized,
        // which force-refreshes the token (this is what the flaky remote network does).
        await act(async () => {
            await api1.options?.onUnauthorized?.()
        })

        // The token did advance...
        expect(result.current.token).toBe('token-2')
        expect(result.current.token).not.toBe(token1)

        // ...but recreating the client was unnecessary: the OLD instance already serves
        // the fresh token via getToken, so nothing downstream needed a new `api` reference.
        expect(api1.options?.getToken?.()).toBe(result.current.token)

        // DESIRED: `api` stays referentially stable across a refresh, so effects keyed on
        // `api` (VoiceBackendSession `[props.api]`, GeneratedImageCard `[ctx.api, ...]`) do
        // NOT re-run / remount. On current code `api` is rebuilt because `token` is a useMemo
        // dep, which drives the Voice-remount spam + per-image refetch storm. This fails today.
        expect(result.current.api).toBe(api1 as unknown as typeof result.current.api)
    })
})
