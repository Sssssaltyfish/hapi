import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useSlashCommands } from './useSlashCommands'

it('reuses a fresh provider catalog and refreshes stale sources before choosing the approval shortcut', async () => {
    const getSlashCommands = vi.fn().mockResolvedValueOnce({ success: true, commands: [{ name: 'native-only', source: 'plugin' }] })
        .mockResolvedValue({ success: true, commands: [{ name: 'approve', source: 'plugin' }] })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useSlashCommands({ getSlashCommands } as unknown as ApiClient, 'session', 'dsh'), { wrapper })
    await waitFor(() => expect(result.current.commands.some(command => command.name === 'native-only')).toBe(true))
    await act(async () => { await result.current.refreshCommands() })
    expect(getSlashCommands).toHaveBeenCalledOnce()
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.slashCommands('session'), refetchType: 'none' }) })
    let commands: Awaited<ReturnType<typeof result.current.refreshCommands>> = null
    await act(async () => { commands = await result.current.refreshCommands() })
    expect(getSlashCommands).toHaveBeenCalledTimes(2)
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'approve', source: 'plugin' })]))
    client.clear()
})
