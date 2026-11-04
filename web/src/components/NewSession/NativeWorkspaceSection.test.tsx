import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { NativeWorkspaceSection, useNativeWorkspace } from './NativeWorkspaceSection'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
}

describe('Native launch workspace selection', () => {
    it('sends project identity separately from execution paths and reuses a created workspace after a failed chat launch', async () => {
        const create = vi.fn().mockResolvedValue({ project: { id: 'created-workspace', name: 'Saved', roots: [{ path: '/workspace' }] } })
        const api = { listCodexNativeProjects: vi.fn().mockResolvedValue({ data: [{ id: 'canonical-project', name: 'Existing', roots: [{ path: '/workspace' }] }], nextCursor: null }), createCodexNativeProject: create } as unknown as ApiClient
        const { result } = renderHook(() => useNativeWorkspace(api, 'native', true), { wrapper })
        expect(await result.current.resolveProjectId('/run-here')).toBeNull()
        expect(api.listCodexNativeProjects).not.toHaveBeenCalled()
        act(() => { result.current.setMode('existing'); result.current.setProjectId('canonical-project') })
        await waitFor(() => expect(result.current.projects).toHaveLength(1))
        expect(await result.current.resolveProjectId('/different-execution-path')).toBe('canonical-project')
        act(() => { result.current.setMode('new'); result.current.setName('Saved') })
        expect(await result.current.resolveProjectId('/workspace')).toBe('created-workspace')
        expect(await result.current.resolveProjectId('/workspace')).toBe('created-workspace')
        expect(create).toHaveBeenCalledTimes(1)
        expect(create).toHaveBeenCalledWith('native', { name: 'Saved', path: '/workspace', idempotencyKey: expect.any(String) })
    })
    it('shows real existing projects and changes the selected execution directory to its root', async () => {
        const api = { listCodexNativeProjects: async () => ({ data: [{ id: 'project-id', name: 'Saved workspace', roots: [{ path: 'C:\\Repo' }] }], nextCursor: null }) } as unknown as ApiClient
        const select = vi.fn()
        function Form() { const workspace = useNativeWorkspace(api, 'windows', true); return <NativeWorkspaceSection workspace={workspace} isDisabled={false} onSelect={select} /> }
        render(<Form />, { wrapper })
        fireEvent.change(screen.getByLabelText('newSession.native.workspace'), { target: { value: 'existing' } })
        await screen.findByRole('option', { name: 'Saved workspace · C:\\Repo' })
        fireEvent.change(screen.getByLabelText('newSession.native.existingWorkspace'), { target: { value: 'project-id' } })
        expect(select).toHaveBeenCalledWith({ id: 'project-id', name: 'Saved workspace', roots: [{ path: 'C:\\Repo' }] })
    })
})
