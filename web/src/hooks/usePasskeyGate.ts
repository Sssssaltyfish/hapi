import { useCallback, useEffect, useState } from 'react'
import type { AuthResponse } from '@/types/api'

export type PasskeySession = AuthResponse & { expiresAt: number }
export const passkeySessionKey = (baseUrl: string) => `hapi_passkey_session::${baseUrl}`

export function usePasskeyGate(baseUrl: string) {
    const [enabled, setEnabled] = useState<boolean | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [session, setSession] = useState<PasskeySession | null>(null)
    const [retry, setRetry] = useState(0)
    useEffect(() => {
        const controller = new AbortController()
        setEnabled(null); setSession(null); setError(null)
        void (async () => {
            try {
                const response = await fetch(`${baseUrl}/api/passkey/config`, { cache: 'no-store', signal: controller.signal })
                if (!response.ok) throw new Error('无法读取登录设置，请检查连接后重试。')
                const config = await response.json() as { enabled: boolean; sharedSession?: boolean }
                if (typeof config.enabled !== 'boolean') throw new Error('登录设置无效。')
                if (controller.signal.aborted) return
                if (config.enabled) {
                    try {
                        localStorage.removeItem(`hapi_access_token::${baseUrl}`)
                        const cached = JSON.parse(sessionStorage.getItem(passkeySessionKey(baseUrl)) || 'null') as PasskeySession | null
                        if (!config.sharedSession && cached && typeof cached.token === 'string' && cached.expiresAt > Date.now()) setSession(cached)
                        else sessionStorage.removeItem(passkeySessionKey(baseUrl))
                    } catch { /* A browser can disallow storage. In-memory login still works. */ }
                    const url = new URL(window.location.href)
                    if (url.searchParams.has('token')) { url.searchParams.delete('token'); window.history.replaceState(null, '', url) }
                    if (config.sharedSession) {
                        const bootstrap = await fetch(`${baseUrl}/api/passkey/session`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
                        if (bootstrap.ok) {
                            const current = await bootstrap.json() as PasskeySession
                            if (!controller.signal.aborted) setSession(current)
                        } else if (bootstrap.status !== 401) {
                            throw new Error('认证服务暂时不可用，请稍后重试。')
                        }
                    }
                }
                if (controller.signal.aborted) return
                setEnabled(config.enabled)
            } catch (error) {
                if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '无法连接 HAPI。')
            }
        })()
        return () => controller.abort()
    }, [baseUrl, retry])
    const login = useCallback((value: PasskeySession) => {
        try { sessionStorage.setItem(passkeySessionKey(baseUrl), JSON.stringify(value)) } catch { /* optional */ }
        setSession(value)
    }, [baseUrl])
    const logout = useCallback(async () => {
        if (session) {
            const response = await fetch(`${baseUrl}/api/passkey/logout`, { method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: '{}' })
            if (!response.ok) throw new Error('退出失败，请重试。')
        }
        try { sessionStorage.removeItem(passkeySessionKey(baseUrl)) } catch { /* optional */ }
        setSession(null)
    }, [baseUrl, session])
    return { enabled, error, session, login, logout, retry: () => setRetry(value => value + 1) }
}
