import { useState } from 'react'
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { Button } from '@/components/ui/button'
import type { PasskeySession } from '@/hooks/usePasskeyGate'

export function PasskeyLogin({ baseUrl, onLogin, error: authError }: {
    baseUrl: string; onLogin: (session: PasskeySession) => void; error?: string | null
}) {
    const [register, setRegister] = useState(false)
    const [code, setCode] = useState('')
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    async function post(path: string, body: unknown) {
        const response = await fetch(`${baseUrl}/api/passkey/${path}`, { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || '请求失败，请重试。')
        return result
    }
    async function submit() {
        setBusy(true); setError(null)
        try {
            if (!browserSupportsWebAuthn()) throw new Error('此浏览器不支持 Passkey，请使用支持 Passkey 的浏览器打开此 HTTPS 地址。')
            if (register) {
                const { options, requestId } = await post('register/options', { code })
                const response = await startRegistration({ optionsJSON: options })
                onLogin(await post('register/verify', { requestId, response, name }))
                setCode('')
            } else {
                const { options, requestId } = await post('login/options', {})
                const response = await startAuthentication({ optionsJSON: options })
                onLogin(await post('login/verify', { requestId, response }))
            }
        } catch (error) {
            const cancelled = error instanceof Error && ['NotAllowedError', 'AbortError'].includes(error.name)
            setError(cancelled ? '操作已取消或超时，可以重试。' : error instanceof Error ? error.message : '验证失败，请重试。')
        } finally { setBusy(false) }
    }
    return <div className="h-full flex items-center justify-center p-6">
        <form className="w-full max-w-sm space-y-5" onSubmit={event => { event.preventDefault(); void submit() }}>
            <div><div className="text-2xl font-semibold">HAPI</div>
                <h1 className="mt-2 text-lg">{register ? '注册 Passkey' : '使用 Passkey 登录'}</h1>
                <p className="mt-2 text-sm text-[var(--app-hint)]">{register
                    ? '输入本机生成的一次性配对码，再按设备提示保存 Passkey。配对码有效期为 10 分钟。'
                    : '使用已保存的 Passkey，通过设备验证后继续。'}</p></div>
            {register && <>
                <label className="block text-sm">一次性配对码
                    <input className="mt-2 w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 font-mono"
                        autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} required disabled={busy} />
                </label>
                <label className="block text-sm">设备名称（可选）
                    <input className="mt-2 w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3"
                        placeholder="例如：我的手机" value={name} maxLength={80} onChange={event => setName(event.target.value)} disabled={busy} />
                </label>
            </>}
            {(error || authError) && <p role="alert" className="text-sm text-red-600">{error || authError}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? '等待设备验证…' : register ? '注册并登录' : '使用 Passkey 登录'}</Button>
            <button type="button" className="w-full text-sm underline" disabled={busy}
                onClick={() => { setRegister(!register); setError(null) }}>{register ? '已有 Passkey，返回登录' : '首次使用或添加设备：用配对码注册'}</button>
        </form>
    </div>
}
