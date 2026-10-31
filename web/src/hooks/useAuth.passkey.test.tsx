import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAuth, type AuthSource } from './useAuth'

const state = vi.hoisted(() => ({ exchange: vi.fn() }))
vi.mock('@/api/client', () => ({ ApiError: class extends Error {
    constructor(message: string, readonly status: number) { super(message) }
}, ApiClient: class {
    authenticate = state.exchange
    constructor(_token: string, readonly options: { onUnauthorized?: () => Promise<unknown> }) {}
} }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('validates the Passkey session without exchanging machine credentials, and clears API access on logout', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ token: 'passkey-token', user: { id: 1 } }) }))
    vi.stubGlobal('fetch', fetchMock)
    const source: AuthSource = { type: 'passkey', token: 'passkey-token' }
    const { result, rerender } = renderHook(({ source }: { source: AuthSource | null }) => useAuth(source, 'https://hapi.test'), { initialProps: { source: source as AuthSource | null } })
    await waitFor(() => expect(result.current.token).toBe('passkey-token'))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://hapi.test/api/passkey/session')
    expect(state.exchange).not.toHaveBeenCalled()
    rerender({ source: null })
    await waitFor(() => expect(result.current.api).toBeNull())
})

it('returns to login after a revoked Passkey session and never falls back to token auth', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'session', user: { id: 1 } }) }).mockResolvedValue({ ok: false, status: 401 })
    vi.stubGlobal('fetch', fetchMock)
    const source: AuthSource = { type: 'passkey', token: 'session' }
    const { result } = renderHook(() => useAuth(source, 'https://hapi.test'))
    await waitFor(() => expect(result.current.api).not.toBeNull())
    const api = result.current.api as unknown as { options: { onUnauthorized: () => Promise<unknown> } }
    await act(async () => { await api.options.onUnauthorized() })
    expect(result.current.api).toBeNull()
    expect(result.current.error).toBeTruthy()
    expect(state.exchange).not.toHaveBeenCalled()
})
