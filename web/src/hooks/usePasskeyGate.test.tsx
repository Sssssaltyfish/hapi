import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { passkeySessionKey, usePasskeyGate } from './usePasskeyGate'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })

it('bootstraps external login from the cookie and discards a previously cached local token', async () => {
    sessionStorage.setItem(passkeySessionKey(''), JSON.stringify({ token: 'old-local-token', expiresAt: Date.now() + 60_000 }))
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, sharedSession: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'new-external-token', user: { id: 1 }, expiresAt: Date.now() + 60_000 }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePasskeyGate(''))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(result.current.session?.token).toBe('new-external-token')
    expect(fetchMock.mock.calls[1]?.[1].credentials).toBe('include')
    expect(sessionStorage.getItem(passkeySessionKey(''))).toBeNull()
})

it('shows the app login when unauthenticated and never falls back to the old local token', async () => {
    sessionStorage.setItem(passkeySessionKey(''), JSON.stringify({ token: 'old-local-token', expiresAt: Date.now() + 60_000 }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, sharedSession: true }) })
        .mockResolvedValueOnce({ ok: false, status: 401 }))
    const { result } = renderHook(() => usePasskeyGate(''))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(result.current.session).toBeNull()
    expect(result.current.error).toBeNull()
})

it('lets the user retry when the shared login service stalls', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, sharedSession: true }) })
        .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePasskeyGate(''))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await act(async () => deadline.abort(new DOMException('Timeout', 'TimeoutError')))
    expect(result.current.error).toBe('连接超时，请重试。')
    vi.mocked(AbortSignal.timeout).mockReturnValue(new AbortController().signal)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false }) })
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.enabled).toBe(false))
    expect(result.current.error).toBeNull()
})
