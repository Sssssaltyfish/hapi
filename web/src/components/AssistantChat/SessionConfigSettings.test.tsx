import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import { SessionConfigSettings } from './SessionConfigSettings'

it('uses advertised opaque preset values and keeps confirmed selection when rejected', async () => {
    const select = vi.fn().mockRejectedValue(new Error('Plugin preset was removed'))
    render(<I18nProvider><SessionConfigSettings api={{ setSessionConfigOption: select } as unknown as ApiClient}
        sessionId="dsh-session" disabled={false} options={[{ id: 'plugin-permission', name: 'Plugin access', category: 'permission', currentValue: 'custom:inspect',
            options: [{ value: 'custom:inspect', name: 'Inspect' }, { value: 'custom:edit', name: 'Edit' }] }]} /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Plugin access'), { target: { value: 'custom:edit' } })
    await waitFor(() => expect(select).toHaveBeenCalledWith('dsh-session', 'plugin-permission', 'custom:edit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Plugin preset was removed')
    expect(screen.getByLabelText('Plugin access')).toHaveValue('custom:inspect')
})
