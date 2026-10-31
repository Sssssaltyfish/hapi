import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { Machine } from '@/types/api'
import SettingsMachinesPage from '@/routes/settings/machines'

const renameMachineMock = vi.fn()
const machinesMock = vi.fn()
const endpointsMock = vi.fn()
const endpointStatusMock = vi.fn()
const renameEndpointMock = vi.fn()
const createEndpointMock = vi.fn()

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: { renameMachine: renameMachineMock, getCodexNativeEndpoints: endpointsMock, getCodexNativeEndpointStatus: endpointStatusMock, renameCodexNativeEndpoint: renameEndpointMock, createCodexNativeEndpoint: createEndpointMock } }),
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({ machines: machinesMock(), isLoading: false, error: null, refetch: vi.fn() }),
}))

function makeMachine(overrides?: Partial<Machine>): Machine {
    return {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'workstation.local',
            platform: 'linux',
            happyCliVersion: '1.0.0',
        },
        ...overrides,
    } as Machine
}

function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SettingsMachinesPage />
            </I18nProvider>
        </QueryClientProvider>,
    )
}

function startEditing(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `Rename ${name}` }))
    return screen.getByRole('textbox')
}

describe('SettingsMachinesPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        renameMachineMock.mockResolvedValue(undefined)
        machinesMock.mockReturnValue([makeMachine()])
        endpointsMock.mockResolvedValue({ endpoints: [] })
        endpointStatusMock.mockResolvedValue({ enabled: true, available: true, platformOs: 'windows', platformFamily: 'windows' })
        renameEndpointMock.mockResolvedValue({ endpoint: {} })
    })

    afterEach(() => {
        cleanup()
    })

    it('lists native and runner machines together with real platform, address, and the same inline rename', async () => {
        endpointsMock.mockResolvedValue({ endpoints: [{ id: 'endpoint-uuid', label: 'Windows box', displayName: 'Windows box', address: 'wss://remote.example:8443', source: 'settings' }] })
        renderPage()
        const rename = await screen.findByRole('button', { name: 'Rename Windows box' })
        await screen.findByText('wss://remote.example:8443 · windows · Connected')
        expect(rename.closest('section')).toBe(screen.getByRole('button', { name: 'Rename workstation.local' }).closest('section'))
        fireEvent.click(rename)
        const input = screen.getByRole('textbox')
        fireEvent.change(input, { target: { value: '  My Windows  ' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.blur(input)
        await waitFor(() => expect(renameEndpointMock).toHaveBeenCalledExactlyOnceWith('endpoint-uuid', 'My Windows'))
    })

    it('adds a native machine using the server-generated identity and refreshes the shared list', async () => {
        const endpoint = { id: 'server-uuid', label: 'Remote Mac', displayName: 'Remote Mac', address: 'wss://mac.example', source: 'settings' }
        createEndpointMock.mockImplementation(async () => { endpointsMock.mockResolvedValue({ endpoints: [endpoint] }); return { endpoint } })
        renderPage()
        fireEvent.click(screen.getByRole('button', { name: 'Add Codex Native machine' }))
        fireEvent.change(screen.getByLabelText('Connection address'), { target: { value: ' wss://mac.example ' } })
        fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Remote Mac' } })
        fireEvent.change(screen.getByLabelText('Authentication token (optional)'), { target: { value: 'test-upload-token' } })
        expect(screen.queryByLabelText('Default directory (optional)')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await screen.findByRole('button', { name: 'Rename Remote Mac' })
        expect(createEndpointMock).toHaveBeenCalledExactlyOnceWith({ address: 'wss://mac.example', displayName: 'Remote Mac', token: 'test-upload-token' })
        expect(screen.queryByDisplayValue('test-upload-token')).toBeNull()
    })

    it('falls back to the hostname and always shows host and platform', () => {
        renderPage()

        expect(screen.getByRole('button', { name: 'Rename workstation.local' })).toBeTruthy()
        expect(screen.getByText('workstation.local · linux')).toBeTruthy()
    })

    it('shows the custom name while keeping the hostname visible', () => {
        machinesMock.mockReturnValue([makeMachine({
            metadata: { host: 'workstation.local', platform: 'linux', happyCliVersion: '1.0.0', displayName: 'Workstation' },
        } as Partial<Machine>)])

        renderPage()

        expect(screen.getByRole('button', { name: 'Rename Workstation' })).toBeTruthy()
        expect(screen.getByText('workstation.local · linux')).toBeTruthy()
    })

    it('seeds the input with the current custom name, not the hostname', () => {
        machinesMock.mockReturnValue([makeMachine({
            metadata: { host: 'workstation.local', platform: 'linux', happyCliVersion: '1.0.0', displayName: 'Workstation' },
        } as Partial<Machine>)])
        renderPage()

        expect((startEditing('Workstation') as HTMLInputElement).value).toBe('Workstation')
    })

    it('seeds the input with the current machine name when no custom name is set', () => {
        renderPage()

        expect((startEditing('workstation.local') as HTMLInputElement).value).toBe('workstation.local')
    })

    it('saves a trimmed name on Enter', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: '  Workstation  ' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalledWith('machine-1', 'Workstation'))
    })

    it('saves on blur', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.blur(input)

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalledWith('machine-1', 'Workstation'))
    })

    it('submits once when Enter is followed by a blur', async () => {
        // Disabling a focused control forces it to blur, so a real browser fires
        // blur right after Enter starts the save. jsdom does not reproduce that,
        // so the sequence is driven explicitly here.
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.blur(input)

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalled())
        expect(renameMachineMock).toHaveBeenCalledTimes(1)
    })

    it('clears the name with an empty string', async () => {
        machinesMock.mockReturnValue([makeMachine({
            metadata: { host: 'workstation.local', platform: 'linux', happyCliVersion: '1.0.0', displayName: 'Workstation' },
        } as Partial<Machine>)])
        renderPage()
        const input = startEditing('Workstation')

        fireEvent.change(input, { target: { value: '   ' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(renameMachineMock).toHaveBeenCalledWith('machine-1', ''))
    })

    it('does not call the API when the name is unchanged', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
        expect(renameMachineMock).not.toHaveBeenCalled()
    })

    it('cancels on Escape without calling the API', async () => {
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.keyDown(input, { key: 'Escape' })

        await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
        expect(renameMachineMock).not.toHaveBeenCalled()
    })

    it('surfaces an error and keeps the editor open when the save fails', async () => {
        renameMachineMock.mockRejectedValue(new Error('HTTP 409'))
        renderPage()
        const input = startEditing('workstation.local')

        fireEvent.change(input, { target: { value: 'Workstation' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(screen.getByText('Could not rename this machine.')).toBeTruthy())
        expect(screen.getByRole('textbox')).toBeTruthy()
    })

    it('renders an empty state when no machines are online', async () => {
        machinesMock.mockReturnValue([])
        renderPage()

        expect(await screen.findByText('No machines online.')).toBeTruthy()
    })
})
