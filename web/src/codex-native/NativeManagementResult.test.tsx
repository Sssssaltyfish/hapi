import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeManagementResult } from './NativeManagementResult'

it('shows the exact denied action and prevents another retry after an unconfirmed acknowledgement', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('Native outcome unconfirmed'))
    render(<I18nProvider><NativeManagementResult result={{ command: 'approve', action: 'show', denial: {
        reviewId: 'review', turnId: 'turn', rationale: 'Review this exact action',
        action: { type: 'command', command: 'echo exact action', cwd: '/project' },
    } }} pending={false} disabled={false} execute={execute} dismiss={() => {}} /></I18nProvider>)
    expect(screen.getByText('echo exact action')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry this action once' })
    fireEvent.click(retry)
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ command: { command: 'approve', action: 'retry', reviewId: 'review' } }))
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(execute).toHaveBeenCalledOnce()
})

it('separates hiding from cancellation and keeps completed hidden recaps unobtrusive', () => {
    const hide = vi.fn(), show = vi.fn(), cancel = vi.fn().mockResolvedValue(undefined)
    const props = { result: null, pending: true, disabled: false, execute: vi.fn(), dismiss: vi.fn(), hideRecap: hide, showRecap: show, cancelRecap: cancel }
    const view = render(<I18nProvider><NativeManagementResult {...props} recaps={[{ clientId: 'run', hidden: false, pending: true, canceling: false, ready: false }]} /></I18nProvider>)
    expect(screen.getByRole('status')).toHaveTextContent('Generating recap…')
    fireEvent.click(screen.getByRole('button', { name: 'Hide recap' }))
    expect(hide).toHaveBeenCalledWith('run')
    expect(cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recap generation' }))
    expect(cancel).toHaveBeenCalledWith('run')
    view.rerender(<I18nProvider><NativeManagementResult {...props} pending={false} recaps={[{ clientId: 'run', hidden: true, pending: false, canceling: false, ready: true }]} /></I18nProvider>)
    expect(screen.queryByRole('region', { name: 'Codex command result' })).not.toBeInTheDocument()
    expect(screen.queryByText('Generating recap…')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Recap available' }))
    expect(show).toHaveBeenCalledWith('run')
})

it('removes a canceled pending recap without a stale global pending indicator', () => {
    render(<I18nProvider><NativeManagementResult result={null} pending={true} disabled={false} execute={vi.fn()} dismiss={vi.fn()} recaps={[]} /></I18nProvider>)
    expect(screen.queryByText('Generating recap…')).not.toBeInTheDocument()
})
