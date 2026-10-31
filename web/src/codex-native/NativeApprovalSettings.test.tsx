import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeApprovalSettings } from './NativeApprovalSettings'
import { createNativeSessionApiAdapter } from './nativeSessionApiAdapter'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

it('keeps a granular policy and sandbox while changing the native approval reviewer', async () => {
    const settings = { approvalPolicy: { granular: { sandbox_approval: true } }, approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'readOnly' } }
    const nativeAction = vi.fn(async (_threadId: string, _action: string, patch: Record<string, unknown>) => ({ applied: { ...settings, ...patch } }))
    const applySettings = vi.fn()
    const setSettingsError = vi.fn()
    const session = { id: 'native-session', metadata: { nativeCodex: { endpointId: 'host', threadId: 'thread' } } } as Session
    const adapter = createNativeSessionApiAdapter({ codexNativeAction: nativeAction } as unknown as ApiClient, {
        session, liveSession: session,
        thread: { requests: [], detail: {}, refreshDetail: vi.fn(), applySettings },
        projected: { requests: {} }, setSettingsError,
    })
    render(<I18nProvider><NativeApprovalSettings settings={settings} disabled={false} onChange={adapter.setNativeApprovalSettings} /></I18nProvider>)
    expect(screen.getByLabelText('Ask for approval')).toHaveValue('')
    expect(screen.getByText('Sandbox: Read only')).toBeInTheDocument()
    expect(nativeAction).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Approval reviewer'), { target: { value: 'user' } })
    await waitFor(() => expect(nativeAction).toHaveBeenCalledWith('thread', 'settings', { approvalsReviewer: 'user' }))
    expect(applySettings).toHaveBeenCalledWith({ ...settings, approvalsReviewer: 'user' })
    await waitFor(() => expect(screen.getByLabelText('Ask for approval')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Ask for approval'), { target: { value: 'on-request' } })
    await waitFor(() => expect(nativeAction).toHaveBeenCalledWith('thread', 'settings', { approvalPolicy: 'on-request' }))
})

it('shows daemon failures without applying unconfirmed native approval settings', async () => {
    const failure = new Error('Approval policy is managed by this host')
    const applySettings = vi.fn()
    const setSettingsError = vi.fn()
    const session = { metadata: { nativeCodex: { threadId: 'thread' } } } as Session
    const adapter = createNativeSessionApiAdapter({ codexNativeAction: vi.fn().mockRejectedValue(failure) } as unknown as ApiClient, {
        session, liveSession: session,
        thread: { requests: [], detail: {}, refreshDetail: vi.fn(), applySettings },
        projected: { requests: {} }, setSettingsError,
    })
    await expect(adapter.setNativeApprovalSettings({ approvalsReviewer: 'auto_review' })).rejects.toThrow(failure.message)
    expect(setSettingsError).toHaveBeenLastCalledWith(failure.message)
    expect(applySettings).not.toHaveBeenCalled()
})
