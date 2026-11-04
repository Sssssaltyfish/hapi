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
            listCodexNativeImportProjects: vi.fn().mockResolvedValue({ data: [{ id: 'project', name: 'Workspace', roots: [] }], nextCursor: null }),
            listCodexNativeProjectThreads: vi.fn().mockResolvedValue({ data: [{ id: 'regular', name: 'Ordinary', source: 'vscode' }], nextCursor: null }),
            listCodexNativeBackgroundThreads: vi.fn().mockResolvedValue({ data: [{ id: 'exec', name: 'Background', source: 'exec' }], nextCursor: null }),
        }
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><NativeImportTree api={api as unknown as ApiClient} endpoints={[{ id: 'windows', label: 'Windows', address: '', source: 'settings' }]} /></QueryClientProvider>)
        expect(api.listCodexNativeImportProjects).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('native-import-toggle'))
        expect(api.listCodexNativeImportProjects).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('native-import-endpoint-windows'))
        await screen.findByTestId('native-import-project-windows-project')
        expect(api.listCodexNativeProjectThreads).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('native-import-project-windows-project'))
        await screen.findByTestId('native-import-thread-regular')
        expect(api.listCodexNativeImportProjects).toHaveBeenCalledTimes(1)
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

    it('opens Desktop-only groups through their read-only identity and keeps daemon actions separate', async () => {
        const api = {
            getConversationCacheScope: () => ({ key: 'desktop-user' }),
            getCodexNativeVisibility: vi.fn().mockResolvedValue({ initialized: true, threadIds: [], hiddenThreadIds: ['hidden'], projects: [] }),
            listCodexNativeImportProjects: vi.fn().mockResolvedValue({ data: [{ id: 'legacy', desktopProjectId: 'legacy', name: 'Desktop workspace', roots: [] }], nextCursor: null }),
            listCodexNativeProjectThreads: vi.fn().mockResolvedValue({ data: [{ id: 'hidden', name: 'Hidden conversation' }], nextCursor: null }),
        }
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><NativeImportTree api={api as unknown as ApiClient} endpoints={[{ id: 'windows', label: 'Windows', address: '', source: 'settings' }]} /></QueryClientProvider>)
        fireEvent.click(screen.getByTestId('native-import-toggle'))
        fireEvent.click(screen.getByTestId('native-import-endpoint-windows'))
        fireEvent.click(await screen.findByTestId('native-import-desktop-project-windows-legacy'))
        await screen.findByTestId('native-import-thread-hidden')
        expect(api.listCodexNativeProjectThreads.mock.calls[0]?.slice(0, 3)).toEqual(['windows', null, undefined])
        expect(api.listCodexNativeProjectThreads.mock.calls[0]?.[4]).toBe('legacy')
        fireEvent.click(screen.getByTestId('native-project-actions-legacy'))
        expect(await screen.findByText('native.catalog.hide')).toBeTruthy()
        expect(screen.queryByText('native.catalog.renameProject')).toBeNull()
    })
})
