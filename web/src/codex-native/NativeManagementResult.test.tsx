import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeManagementResult } from './NativeManagementResult'

it('shows the exact denied action and prevents another retry after an unconfirmed acknowledgement', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('Native outcome unconfirmed'))
    render(<I18nProvider><NativeManagementResult result={{ command: 'approve', action: 'show', denial: {
        reviewId: 'review', turnId: 'turn', rationale: 'Review this exact action',
        action: { type: 'command', command: 'echo exact action', cwd: '/project' },
    } }} pendingCommand={null} pending={false} disabled={false} execute={execute} dismiss={() => {}} /></I18nProvider>)
    expect(screen.getByText('echo exact action')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry this action once' })
    fireEvent.click(retry)
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ command: { command: 'approve', action: 'retry', reviewId: 'review' } }))
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(execute).toHaveBeenCalledOnce()
})
