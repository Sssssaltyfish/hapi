import { afterEach, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { passkeySessionKey, usePasskeyGate } from './usePasskeyGate'

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

it('bootstraps external login from the cookie and discards a previously cached local token', async () => {
    sessionStorage.setItem(passkeySessionKey(''), JSON.stringify({ token: 'old-local-token', expiresAt: Date.now() + 60_000 }))
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, externalLoginUrl: 'https://seia.test/auth/?app=hapi' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'new-external-token', user: { id: 1 }, expiresAt: Date.now() + 60_000 }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePasskeyGate(''))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(result.current.session?.token).toBe('new-external-token')
    expect(fetchMock.mock.calls[1]?.[1].credentials).toBe('include')
    expect(sessionStorage.getItem(passkeySessionKey(''))).toBeNull()
})

it('offers central login when unauthenticated and never falls back to the old local token', async () => {
    sessionStorage.setItem(passkeySessionKey(''), JSON.stringify({ token: 'old-local-token', expiresAt: Date.now() + 60_000 }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, externalLoginUrl: 'https://seia.test/auth/?app=hapi' }) })
        .mockResolvedValueOnce({ ok: false, status: 401 }))
    const { result } = renderHook(() => usePasskeyGate(''))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(result.current.session).toBeNull()
    expect(result.current.externalLoginUrl).toContain('/auth/')
    expect(result.current.error).toBeNull()
})
