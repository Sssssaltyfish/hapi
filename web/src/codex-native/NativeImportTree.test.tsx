import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { NativeImportTree } from './NativeImportTree'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

describe('NativeImportTree', () => {
    it('loads only explicitly opened endpoint/workspace pages and leaves background rows collapsed', async () => {
        const api = {
            getConversationCacheScope: () => ({ key: 'test-user' }),
            getCodexNativeVisibility: vi.fn().mockResolvedValue({ initialized: true, threadIds: [], hiddenThreadIds: [], projects: [] }),
            listCodexNativeProjects: vi.fn().mockResolvedValue({ data: [{ id: 'project', name: 'Workspace', roots: [] }], nextCursor: null }),
            listCodexNativeProjectThreads: vi.fn().mockResolvedValue({ data: [{ id: 'regular', name: 'Ordinary', source: 'vscode' }], nextCursor: null }),
            listCodexNativeBackgroundThreads: vi.fn().mockResolvedValue({ data: [{ id: 'exec', name: 'Background', source: 'exec' }], nextCursor: null }),
        }
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><NativeImportTree api={api as unknown as ApiClient} endpoints={[{ id: 'windows', label: 'Windows', address: '', source: 'settings' }]} /></QueryClientProvider>)
        expect(api.listCodexNativeProjects).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('native-import-toggle'))
        expect(api.listCodexNativeProjects).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('native-import-endpoint-windows'))
        await screen.findByTestId('native-import-project-windows-project')
        expect(api.listCodexNativeProjectThreads).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('native-import-project-windows-project'))
        await screen.findByTestId('native-import-thread-regular')
        expect(api.listCodexNativeProjects).toHaveBeenCalledTimes(1)
        expect(api.listCodexNativeProjectThreads).toHaveBeenCalledTimes(1)
        expect(screen.getByTestId('native-import-background-windows').getAttribute('aria-expanded')).toBe('false')
        expect(api.listCodexNativeBackgroundThreads).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('native-import-projectless-windows'))
        await waitFor(() => expect(api.listCodexNativeProjectThreads).toHaveBeenCalledTimes(2))
        expect(api.listCodexNativeProjectThreads.mock.calls[1]?.[1]).toBeNull()
        fireEvent.click(screen.getByTestId('native-import-background-windows'))
        await screen.findByTestId('native-import-thread-exec')
        expect(api.listCodexNativeBackgroundThreads).toHaveBeenCalledTimes(1)
    })
})
