import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { WorkspaceBrowser } from './WorkspaceBrowser'
import { nativeWorkspaceBrowserSource, runnerWorkspaceBrowserSource } from './WorkspaceBrowserSource'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
}

describe('shared workspace browser', () => {
    beforeEach(() => localStorage.clear())
    it.each([
        { id: 'windows', current: 'C:\\Work', child: 'C:\\Work\\Repo' },
        { id: 'wsl', current: '/home/igna', child: '/home/igna/Repo' },
    ])('uses the standard browser controls for Native $id directories', async ({ id, current, child }) => {
        const list = vi.fn(async (_endpoint: string, path: string) => ({ path: path || current, parentPath: '/', entries: path === child ? [] : [{ fileName: 'Repo', path: child }], truncated: false }))
        const api = { listCodexNativeDirectory: list } as unknown as ApiClient
        const source = nativeWorkspaceBrowserSource(api, [{ id, label: id, address: 'ws://target', source: 'env' }], false, id, current)
        const select = vi.fn()
        render(<WorkspaceBrowser source={source} initialMachineId={id} initialDirectory={current} onStartSession={select} />, { wrapper })
        fireEvent.click(await screen.findByRole('button', { name: 'Repo' }))
        await waitFor(() => expect(list).toHaveBeenCalledWith(id, child, false))
        fireEvent.click(screen.getByRole('button', { name: 'browse.showHidden' }))
        await waitFor(() => expect(list).toHaveBeenCalledWith(id, child, true))
        fireEvent.click(screen.getByRole('button', { name: 'browse.startSession' }))
        expect(select).toHaveBeenCalledWith(id, child)
    })

    it('keeps runner directory loading scoped to its reported roots with the same confirm control', async () => {
        const list = vi.fn().mockResolvedValue({ success: true, entries: [] })
        const api = { listMachineDirectory: list } as unknown as ApiClient
        const machine = { id: 'runner', metadata: { host: 'Linux runner', workspaceRoots: ['/projects'] } } as Machine
        const select = vi.fn()
        render(<WorkspaceBrowser source={runnerWorkspaceBrowserSource(api, [machine], false)} initialMachineId="runner" initialDirectory="/projects/current" onStartSession={select} />, { wrapper })
        await waitFor(() => expect(list).toHaveBeenCalledWith('runner', '/projects/current', { includeHidden: false }))
        fireEvent.click(screen.getByRole('button', { name: 'browse.startSession' }))
        expect(select).toHaveBeenCalledWith('runner', '/projects/current')
    })
})
