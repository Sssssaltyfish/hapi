import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { MachineSettingsRow } from './MachineSettingsRow'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('edits the visible machine name and uses its base name when the override is cleared', async () => {
    const rename = vi.fn().mockResolvedValue(undefined)
    render(<QueryClientProvider client={new QueryClient()}><MachineSettingsRow label="Windows Native" fallbackName="Configured Windows" onRename={rename} onRenamed={vi.fn()} /></QueryClientProvider>)
    fireEvent.click(screen.getByRole('button'))
    const input = screen.getByRole('textbox')
    expect(input).toHaveValue('Windows Native')
    fireEvent.blur(input)
    expect(rename).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Configured Windows')
    fireEvent.blur(screen.getByRole('textbox'))
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1))
    expect(rename.mock.calls[0][0]).toBe('')
})
