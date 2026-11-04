import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { useTranslation } from '@/lib/use-translation'
import { PasskeySessionStatus } from './PasskeyLogin'

function ChangeLanguage() {
    const { setLocale } = useTranslation()
    return <button onClick={() => setLocale('zh-CN')}>Change language</button>
}

describe('local passkey session status', () => {
    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem('hapi-lang', 'en')
    })

    it('follows the saved application language without changing the authentication action', () => {
        const logout = vi.fn()
        render(<I18nProvider><PasskeySessionStatus onLogout={logout} /><ChangeLanguage /></I18nProvider>)
        expect(screen.getByText('Signed in with Passkey')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Change language' }))
        expect(screen.getByText('已使用 Passkey 登录')).toBeInTheDocument()
        expect(localStorage.getItem('hapi-lang')).toBe('zh-CN')
        expect(logout).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
        expect(logout).toHaveBeenCalledTimes(1)
    })
})
