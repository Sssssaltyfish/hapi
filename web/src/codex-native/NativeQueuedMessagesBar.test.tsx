import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeQueuedMessagesBar } from './NativeQueuedMessagesBar'

function fixture(options: { connected?: boolean; activeTurnId?: string | null } = {}) {
    const action = vi.fn(async () => ({ accepted: true } as Record<string, unknown>))
    const refresh = vi.fn(async () => {})
    const queue = { items: [{ id: 'queued-id', input: [{ type: 'text', text: 'queued input' }] }], error: '', refresh }
    const ui = () => <I18nProvider><NativeQueuedMessagesBar api={{ codexNativeAction: action } as unknown as ApiClient}
        threadId="thread" queue={queue} connected={options.connected ?? true}
        activeTurnId={options.activeTurnId === undefined ? 'active-turn' : options.activeTurnId} /></I18nProvider>
    const view = render(ui())
    return { ...view, action, refresh, queue, rerenderQueue: () => view.rerender(ui()) }
}

describe('NativeQueuedMessagesBar', () => {
    afterEach(cleanup)

    it('steers by the existing queue ID and active-turn precondition without resubmitting its text', async () => {
        const { action, refresh } = fixture()
        fireEvent.click(screen.getByRole('button', { name: 'Deliver into the running turn now' }))
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
        expect(action).toHaveBeenCalledExactlyOnceWith('thread', 'queue/steer', { queuedSubmissionId: 'queued-id', expectedTurnId: 'active-turn' })
        expect(screen.getByRole('button', { name: 'Deliver into the running turn now' })).toBeDisabled()
        expect(screen.getByText('↳ Steered')).toBeInTheDocument()
    })

    it('keeps a rejected steer available and shows the daemon error', async () => {
        const { action, refresh } = fixture()
        action.mockRejectedValueOnce(new Error('turn changed'))
        fireEvent.click(screen.getByRole('button', { name: 'Deliver into the running turn now' }))
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
        expect(screen.getByRole('alert')).toHaveTextContent('turn changed')
        expect(screen.getByText('queued input')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Deliver into the running turn now' })).toBeEnabled()
    })

    it('does not offer to resend an accepted steer when queue cleanup fails', async () => {
        const { action, refresh, queue, rerenderQueue } = fixture()
        action.mockResolvedValueOnce({ accepted: true, cleanupError: 'cleanup disconnected' })
        fireEvent.click(screen.getByRole('button', { name: 'Deliver into the running turn now' }))
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
        expect(screen.getByRole('alert')).toHaveTextContent('Delivered to the current turn.')
        expect(screen.getByRole('alert')).toHaveTextContent('cleanup disconnected')
        const steer = screen.getByRole('button', { name: 'Deliver into the running turn now' })
        expect(steer).toBeDisabled()
        fireEvent.click(steer)
        expect(action).toHaveBeenCalledTimes(1)
        const originalItems = queue.items
        queue.items = []; queue.error = 'queue refresh failed'
        rerenderQueue()
        queue.items = originalItems; queue.error = ''
        rerenderQueue()
        expect(screen.getByRole('button', { name: 'Deliver into the running turn now' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
        await waitFor(() => expect(action).toHaveBeenCalledTimes(2))
        expect(action).toHaveBeenLastCalledWith('thread', 'queue/delete', { queuedSubmissionId: 'queued-id' })
    })

    it.each([{ activeTurnId: null }, { connected: false }])('disables steer when the running turn is unavailable: %j', (options) => {
        const { action } = fixture(options)
        const steer = screen.getByRole('button', { name: 'Deliver into the running turn now' })
        expect(steer).toBeDisabled()
        fireEvent.click(steer)
        expect(action).not.toHaveBeenCalled()
    })
})
