import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { PendingApprovalDialog } from './PendingApprovalDialog'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))
// Keep the shared permission footer real; the detail view simply exposes its input.
vi.mock('./ToolCard', () => ({ ToolDetailDialogContent: ({ block, footer }: { block: { tool: { input: unknown } }; footer: ReactNode }) =>
    <div><pre>{JSON.stringify(block.tool.input)}</pre>{footer}</div> }))

it('shows the actual action without approving until the existing Allow control is explicitly clicked', async () => {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const denyPermission = vi.fn()
    const onClose = vi.fn()
    const api = { approvePermission, denyPermission } as unknown as ApiClient
    render(<I18nProvider><PendingApprovalDialog api={api} sessionId="this-session" metadata={{ path: '/test', host: 'test', flavor: 'claude' }}
        state={{ requests: { 'this-request': { tool: 'Bash', arguments: { command: 'git status --short' } } } }}
        requestId="this-request" disabled={false} onClose={onClose} onRefresh={vi.fn()} /></I18nProvider>)
    expect(await screen.findByText(/git status --short/)).toBeTruthy()
    expect(approvePermission).not.toHaveBeenCalled()
    expect(denyPermission).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(approvePermission).toHaveBeenCalledExactlyOnceWith('this-session', 'this-request'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
})

it('provides no controls for a request from a different session or one already answered', () => {
    const api = { approvePermission: vi.fn() } as unknown as ApiClient
    const { container } = render(<I18nProvider><PendingApprovalDialog api={api} sessionId="another-session" metadata={{ path: '/test', host: 'test', flavor: 'claude' }}
        state={{ requests: { other: { tool: 'Bash', arguments: {} } } }} requestId="original-request"
        disabled={false} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(container.textContent).toBe('')
    expect(api.approvePermission).not.toHaveBeenCalled()
})
