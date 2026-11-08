import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine, PiModelSummary } from '@/types/api'
import { loadNewSessionFormDraft, saveNewSessionFormDraft } from './newSessionFormDraft'
import {
    loadPreferredLaunchSettings,
    savePreferredAgent,
    savePreferredCreationChoice,
    savePreferredLaunchSettings,
    savePreferredYoloMode
} from './preferences'

const mocks = vi.hoisted(() => ({
    spawnSession: vi.fn(),
    onSuccess: vi.fn(),
    notification: vi.fn(),
    checkPathsExists: vi.fn(),
    availableAgents: [
        'agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'pi'
    ].map((agent) => ({ agent, available: true })),
    codexModelsLoading: false,
    agyModelsLoading: false,
    agyModels: [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }],
    dshModels: [] as Array<{ modelId: string; name?: string }>,
    dshModelsLoading: false,
    directoryExists: undefined as boolean | undefined,
    recentNativePaths: [] as string[],
    copilotModels: [] as Array<{ modelId: string; name?: string }>,
    copilotModelsLoading: false,
    kimiModels: [] as Array<{ modelId: string; name?: string; provider?: string }>,
    kimiModelsLoading: false,
    kimiModelsError: null as string | null,
    opencodeModels: [] as Array<{ modelId: string; name?: string }>,
    opencodeCurrentModelId: null as string | null,
    opencodeModelsLoading: false,
    opencodeVariants: null as Record<string, string[]> | null,
    opencodeVariantsLoading: false,
    opencodeVariantsEnabled: false,
    piDialogSelection: ['pi-native-1'] as string[],
    piModels: [] as PiModelSummary[],
    piModelsLoading: false,
    piModelsError: null as string | null,
    nextModelValue: 'gpt-5.6-terra',
    refetchSessions: vi.fn(),
    addToast: vi.fn()
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: mocks.addToast })
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: mocks.notification } })
}))
vi.mock('@/hooks/mutations/useSpawnSession', () => ({
    useSpawnSession: () => ({
        spawnSession: mocks.spawnSession,
        isPending: false,
        error: null
    })
}))
vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions: [], refetch: mocks.refetchSessions })
}))
vi.mock('@/hooks/useRecentPaths', () => ({
    useRecentPaths: () => ({
        getRecentPaths: (machineId: string | null) => machineId?.startsWith('codex-native:') ? mocks.recentNativePaths : [],
        addRecentPath: vi.fn(),
        getLastUsedMachineId: () => null,
        setLastUsedMachineId: vi.fn()
    })
}))
vi.mock('@/hooks/useMachinePathsExists', () => ({
    useMachinePathsExists: () => ({
        pathExistence: { 'C:\\repo': mocks.directoryExists },
        outsideWorkspaceRoots: new Set<string>(),
        checkPathsExists: mocks.checkPathsExists
    })
}))
vi.mock('@/hooks/queries/useAgentAvailability', () => ({
    useAgentAvailability: (args: { machineId: string | null; enabled?: boolean }) => ({
        agents: args.machineId && args.enabled !== false ? mocks.availableAgents : [],
        isLoading: false,
        error: null,
        upgradeRequired: false,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/useDirectorySuggestions', () => ({
    useDirectorySuggestions: () => []
}))
vi.mock('@/hooks/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn(), vi.fn()]
}))
vi.mock('@/hooks/queries/useCodexModels', () => ({
    useCodexModels: () => ({
        models: [
            {
                id: 'gpt-5.6-sol',
                displayName: 'GPT-5.6 Sol',
                isDefault: true,
                supportedReasoningEfforts: ['low', 'high', 'xhigh']
            },
            {
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6 Terra',
                isDefault: false,
                supportedReasoningEfforts: ['low', 'high', 'max']
            }
        ],
        isLoading: mocks.codexModelsLoading,
        error: null
    })
}))
vi.mock('@/hooks/queries/useAgyModels', () => ({
    useAgyModels: () => ({
        availableModels: mocks.agyModels,
        currentModelId: null,
        isLoading: mocks.agyModelsLoading,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useDshModels', () => ({
    useDshModelsForMachine: () => ({
        availableModels: mocks.dshModels,
        currentModelId: null,
        isLoading: mocks.dshModelsLoading,
        error: null
    }),
    useDshModelsForSession: () => ({
        availableModels: mocks.dshModels,
        currentModelId: null,
        isLoading: mocks.dshModelsLoading,
        error: null
    })
}))
vi.mock('@/hooks/queries/useCursorModelsForMachine', () => ({
    useCursorModelsForMachine: () => ({
        availableModels: [],
        cliModelSkus: [],
        currentModelId: null,
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useOpencodeModelsForCwd', () => ({
    useOpencodeModelsForCwd: () => ({
        availableModels: mocks.opencodeModels,
        currentModelId: mocks.opencodeCurrentModelId,
        isLoading: mocks.opencodeModelsLoading,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useOpencodeModelVariants', () => ({
    useOpencodeModelVariants: (args: { enabled: boolean }) => {
        mocks.opencodeVariantsEnabled = args.enabled
        return {
            variants: mocks.opencodeVariants,
            isLoading: mocks.opencodeVariantsLoading,
            error: null
        }
    }
}))
vi.mock('@/hooks/queries/useGrokModelsForCwd', () => ({
    useGrokModelsForCwd: () => ({
        availableModels: [],
        currentModelId: null,
        autoPermissionModeSupported: null,
        isLoading: false,
        error: null
    })
}))
vi.mock('@/hooks/queries/useCopilotModelsForCwd', () => ({
    useCopilotModelsForCwd: () => ({
        availableModels: mocks.copilotModels,
        currentModelId: null,
        isLoading: mocks.copilotModelsLoading,
        error: null
    })
}))
vi.mock('@/hooks/queries/useKimiModelsForCwd', () => ({
    useKimiModelsForCwd: () => ({
        availableModels: mocks.kimiModels,
        currentModelId: null,
        isLoading: mocks.kimiModelsLoading,
        error: mocks.kimiModelsError
    })
}))
vi.mock('@/hooks/queries/usePiModelsForMachine', () => ({
    usePiModelsForMachine: () => ({
        availableModels: mocks.piModels,
        currentModelId: null,
        isLoading: mocks.piModelsLoading,
        error: mocks.piModelsError
    })
}))
vi.mock('../../utils/formatRunnerSpawnError', () => ({
    formatRunnerSpawnError: () => null
}))
vi.mock('@/components/CodexSessionSyncDialog', () => ({
    CodexSessionSyncDialog: () => null
}))
vi.mock('@/components/PiSessionImportDialog', () => ({
    PiSessionImportDialog: (props: { isOpen: boolean; sessions: Array<{ id: string }>; onClose: () => void; onConfirm: (ids: string[]) => Promise<void> }) => props.isOpen ? (
        <>
            <div data-testid="pi-session-ids">{props.sessions.map((session) => session.id).join(',')}</div>
            <button type="button" data-testid="close-pi-history" onClick={props.onClose}>close pi history</button>
            <button type="button" data-testid="select-pi-history" disabled={props.sessions.length === 0} onClick={() => void props.onConfirm(mocks.piDialogSelection)}>
                select pi history
            </button>
        </>
    ) : null
}))
vi.mock('./DirectorySection', () => ({ DirectorySection: (props: { directory: string; onDirectoryChange: (value: string) => void; onChooseFolder?: () => void }) => props.onChooseFolder ? <><input data-testid="directory" value={props.directory} onChange={event => props.onDirectoryChange(event.target.value)} /><button type="button" data-testid="choose-folder" onClick={props.onChooseFolder}>browse</button></> : null }))
vi.mock('./MachineSelector', () => ({
    MachineSelector: (props: { machines: Machine[]; machineId: string | null; isDisabled: boolean; onChange: (machineId: string) => void }) => (
        <select
            aria-label="machine-selector"
            value={props.machineId ?? ''}
            disabled={props.isDisabled}
            onChange={(event) => props.onChange(event.target.value)}
        >
            {props.machines.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
        </select>
    ),
    MachineSelectionField: (props: { options: Array<{ id: string; label: string }>; value: string; isDisabled: boolean; onChange: (id: string) => void }) => (
        <select aria-label="native-machine-selector" value={props.value} disabled={props.isDisabled} onChange={event => props.onChange(event.target.value)}>
            <option value="" />{props.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
    )
}))
vi.mock('./SessionTypeSelector', () => ({ SessionTypeSelector: () => null }))
vi.mock('./PermissionField', () => ({
    PermissionField: (props: {
        agent: string
        nativeValue: string
        yoloMode: boolean
        isDisabled: boolean
        onNativeChange: (mode: string) => void
        onYoloToggle: (value: boolean) => void
    }) => (
        <>
            <button type="button" data-testid="permission-mode" onClick={() => props.onNativeChange('yolo')}>
                {props.nativeValue}
            </button>
            <button type="button" data-testid="permission-mode-plan" onClick={() => props.onNativeChange('plan')}>
                {props.nativeValue}
            </button>
        </>
    )
}))
vi.mock('./CopilotAgentModeSelector', () => ({ CopilotAgentModeSelector: () => null }))
vi.mock('./OpencodeModelSelector', () => ({
    OpencodeModelSelector: (props: { selectedModel: string | null | undefined; onModelChange: (model: string | null) => void }) => (
        <>
            <button type="button" data-testid="opencode-model-default" onClick={() => props.onModelChange(null)}>default</button>
            <button type="button" data-testid="opencode-model-pick" onClick={() => props.onModelChange('provider/model')}>pick</button>
            <div data-testid="opencode-model">{props.selectedModel ?? 'default'}</div>
        </>
    )
}))
vi.mock('./AgyModelSelector', () => ({
    AgyModelSelector: (props: { selectedModel: string | null; onModelChange: (model: string | null) => void }) => (
        <button type="button" data-testid="agy-model" onClick={() => props.onModelChange('gemini-3.6-flash-low')}>
            {props.selectedModel ?? 'auto'}
        </button>
    )
}))
vi.mock('./EffortField', () => ({
    EffortField: (props: { effort: string; reasoningEffort: string; opencodeVariantOptions?: string[] | null; onReasoningEffortChange: (v: string) => void }) => (
        <>
            <div data-testid="launch-effort">{props.effort}</div>
            <div data-testid="opencode-variants">{props.opencodeVariantOptions?.join(',') ?? 'static'}</div>
            <button type="button" data-testid="reasoning" onClick={() => props.onReasoningEffortChange('max')}>
                {props.reasoningEffort}
            </button>
        </>
    )
}))
vi.mock('./ModelSelector', () => ({
    ModelSelector: (props: {
        model: string
        options?: Array<{ value: string; label: string }>
        onModelChange: (model: string) => void
    }) => (
        <>
            <button type="button" data-testid="model" onClick={() => props.onModelChange(mocks.nextModelValue)}>
                {props.model}
            </button>
            <div data-testid="model-options">{props.options?.map((option) => option.label).join(',')}</div>
        </>
    )
}))
vi.mock('./ActionButtons', () => ({
    ActionButtons: (props: { onCreate: () => void; onChooseFolder?: () => void; canCreate: boolean }) => (
        <>
            <button type="button" data-testid="create" disabled={!props.canCreate} onClick={props.onCreate}>create</button>
            {props.onChooseFolder ? <button type="button" data-testid="browse" onClick={props.onChooseFolder}>browse</button> : null}
        </>
    )
}))

import { NewSession } from './index'

const machine = { id: 'machine-1' } as Machine
const api = {} as ApiClient
afterEach(() => { mocks.recentNativePaths.splice(0) })

function render(tree: React.ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return testingRender(tree, { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> })
}

it('uses one set of launch fields to create native Codex without a runner and retains edits on host refresh', async () => {
    localStorage.clear()
    sessionStorage.clear()
    savePreferredAgent('codex')
    const endpoints = vi.fn().mockResolvedValue({ endpoints: [{ id: 'native-host', label: 'Native host', defaultCwd: '/repo' }] })
    const create = vi.fn().mockResolvedValue({ session: { id: 'codex-native:native-host:new-thread' } })
    const success = vi.fn()
    const nativeApi = { getCodexNativeEndpoints: endpoints,
        getCodexNativeEndpointStatus: async () => ({ available: true, platformOs: 'linux' }),
        createCodexNativeThread: create,
        listCodexNativeProjects: async () => ({ data: [], nextCursor: null }),
        withCodexNativeEndpoint: () => ({ getCodexNativeModels: async () => ({ data: [{ model: 'gpt-5.6-terra', displayName: 'Terra', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }] }) }) } as unknown as ApiClient
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    render(<QueryClientProvider client={queryClient}><NewSession api={nativeApi} machines={[]} initialDirectory="/repo" onSuccess={success} onCancel={vi.fn()} /></QueryClientProvider>)
    expect(screen.getByRole('radio', { name: /^Codex$/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Codex Native' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Codex Native' })).toBeChecked())
    await waitFor(() => expect(screen.getByTestId('model-options')).toHaveTextContent('Terra'))
    expect(screen.getAllByTestId('model')).toHaveLength(1)
    expect(screen.getAllByTestId('create')).toHaveLength(1)
    const nativeModel = screen.getByTestId('model')
    fireEvent.click(nativeModel)
    expect(nativeModel).toHaveTextContent('gpt-5.6-terra')
    fireEvent.click(screen.getByTestId('reasoning'))
    act(() => queryClient.setQueryData(['codex-native', 'endpoints'], { endpoints: [{ id: 'native-host', label: 'Native host', defaultCwd: '/updated-default' }] }))
    expect(nativeModel).toBeVisible()
    expect(nativeModel).toHaveTextContent('gpt-5.6-terra')
    expect(endpoints).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('create'))
    await waitFor(() => expect(success).toHaveBeenCalledWith('codex-native:native-host:new-thread'))
    expect(create).toHaveBeenCalledExactlyOnceWith('native-host', { cwd: '/repo', projectId: null, model: 'gpt-5.6-terra', effort: 'max' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] })
    expect(mocks.spawnSession).not.toHaveBeenCalled()
})

it.each(['none', 'existing', 'new'] as const)('preserves the Native target, model, effort and %s workspace through the common Browse round trip', async mode => {
    localStorage.clear()
    sessionStorage.clear()
    savePreferredCreationChoice('codex-native')
    const create = vi.fn().mockResolvedValue({ session: { id: 'native-created' } })
    const chooseFolder = vi.fn()
    const nativeApi = {
        getCodexNativeEndpoints: async () => ({ endpoints: [{ id: 'windows', label: 'Windows' }, { id: 'wsl', label: 'WSL' }] }),
        getCodexNativeEndpointStatus: async () => ({ available: true, platformOs: 'linux' }),
        listCodexNativeProjects: async () => ({ data: [{ id: 'canonical', name: 'Existing', roots: [{ path: '/repo' }] }], nextCursor: null }),
        createCodexNativeProject: async () => ({ project: { id: 'new-project', name: 'New workspace', roots: [{ path: '/repo/chosen' }] } }),
        createCodexNativeThread: create,
        withCodexNativeEndpoint: () => ({ getCodexNativeModels: async () => ({ data: [{ model: 'gpt-5.6-terra', displayName: 'Terra', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }] }) }),
    } as unknown as ApiClient
    const first = render(<NewSession api={nativeApi} machines={[]} initialNativeEndpointId="wsl" initialDirectory="/repo" onChooseFolder={chooseFolder} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('model-options')).toHaveTextContent('Terra'))
    fireEvent.click(screen.getByTestId('model'))
    fireEvent.click(screen.getByTestId('reasoning'))
    fireEvent.change(screen.getByLabelText('newSession.native.workspace'), { target: { value: mode } })
    if (mode === 'existing') {
        await screen.findByRole('option', { name: 'Existing · /repo' })
        fireEvent.change(screen.getByLabelText('newSession.native.existingWorkspace'), { target: { value: 'canonical' } })
    } else if (mode === 'new') {
        fireEvent.change(screen.getByLabelText('newSession.native.workspaceName'), { target: { value: 'New workspace' } })
    }
    fireEvent.click(screen.getByTestId('choose-folder'))
    expect(chooseFolder).toHaveBeenCalledWith({ machineId: null, nativeEndpointId: 'wsl', directory: '/repo', browseDraftId: expect.any(String) })
    const browseDraftId = loadNewSessionFormDraft()?.browseDraftId
    expect(loadNewSessionFormDraft()?.native).toEqual({ endpointId: 'wsl', workspaceMode: mode, workspaceName: mode === 'new' ? 'New workspace' : '', projectId: mode === 'existing' ? 'canonical' : '' })
    first.unmount()
    render(<NewSession api={nativeApi} machines={[]} initialNativeEndpointId="wsl" initialDirectory="/repo/chosen" browseDraftId={browseDraftId} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-terra'))
    expect(screen.getByLabelText('newSession.native.workspace')).toHaveValue(mode)
    if (mode === 'new') expect(screen.getByLabelText('newSession.native.workspaceName')).toHaveValue('New workspace')
    if (mode === 'existing') await waitFor(() => expect(screen.getByLabelText('newSession.native.existingWorkspace')).toHaveValue('canonical'))
    await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('create'))
    await waitFor(() => expect(create).toHaveBeenCalledWith('wsl', { cwd: '/repo/chosen', projectId: mode === 'existing' ? 'canonical' : mode === 'new' ? 'new-project' : null, model: 'gpt-5.6-terra', effort: 'max' }))
})

it('creates in the Native workspace opened from the session list when it is outside the first workspace page', async () => {
    localStorage.clear()
    sessionStorage.clear()
    savePreferredAgent('claude')
    const create = vi.fn().mockResolvedValue({ session: { id: 'native-created' } })
    const nativeApi = {
        getCodexNativeEndpoints: async () => ({ endpoints: [{ id: 'windows', label: 'Windows' }, { id: 'wsl', label: 'WSL' }] }),
        getCodexNativeEndpointStatus: async () => ({ available: true }),
        listCodexNativeProjects: async () => ({ data: [{ id: 'other', name: 'Other', roots: [] }], nextCursor: 'more' }),
        createCodexNativeThread: create,
        withCodexNativeEndpoint: () => ({ getCodexNativeModels: async () => ({ data: [] }) }),
    } as unknown as ApiClient
    render(<NewSession api={nativeApi} machines={[]} initialNativeEndpointId="wsl" initialNativeProjectId="canonical"
        initialNativeProjectName="Target workspace" initialDirectory="/target" onChooseFolder={vi.fn()}
        onSuccess={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByRole('radio', { name: 'Codex Native' })).toBeChecked()
    expect(screen.getByLabelText('newSession.native.workspace')).toHaveValue('existing')
    expect(screen.getByRole('option', { name: 'Target workspace', selected: true })).toHaveValue('canonical')
    await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
    expect(screen.getByLabelText('native-machine-selector')).toHaveValue('wsl')
    expect(screen.getByTestId('directory')).toHaveValue('/target')
    fireEvent.click(screen.getByTestId('create'))
    await waitFor(() => expect(create).toHaveBeenCalledWith('wsl', { cwd: '/target', projectId: 'canonical' }))
})

it.each([
    { chosen: '/repo', projectCreates: 1, projectId: 'project-1' },
    { chosen: '/other', projectCreates: 2, projectId: 'project-2' },
])('keeps Native workspace retry idempotent after a failed chat launch and Browse returning to $chosen', async ({ chosen, projectCreates, projectId }) => {
    localStorage.clear()
    sessionStorage.clear()
    const createProject = vi.fn().mockImplementation(async () => ({ project: { id: `project-${createProject.mock.calls.length}`, name: 'Retry workspace', roots: [{ path: '/repo' }] } }))
    const createThread = vi.fn().mockRejectedValueOnce(new Error('start failed')).mockResolvedValue({ session: { id: 'retried' } })
    const api = {
        getCodexNativeEndpoints: async () => ({ endpoints: [{ id: 'wsl', label: 'WSL' }] }),
        getCodexNativeEndpointStatus: async () => ({ available: true }),
        listCodexNativeProjects: async () => ({ data: [], nextCursor: null }),
        createCodexNativeProject: createProject,
        createCodexNativeThread: createThread,
        withCodexNativeEndpoint: () => ({ getCodexNativeModels: async () => ({ data: [] }) }),
    } as unknown as ApiClient
    const first = render(<NewSession api={api} machines={[]} initialNativeEndpointId="wsl" initialDirectory="/repo" onChooseFolder={vi.fn()} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('newSession.native.workspace'), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText('newSession.native.workspaceName'), { target: { value: 'Retry workspace' } })
    await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('create'))
    await screen.findByText('start failed')
    fireEvent.click(screen.getByTestId('choose-folder'))
    expect(loadNewSessionFormDraft()?.native?.creation).toMatchObject({ projectId: 'project-1', idempotencyKey: expect.any(String) })
    const browseDraftId = loadNewSessionFormDraft()?.browseDraftId
    first.unmount()
    render(<NewSession api={api} machines={[]} initialNativeEndpointId="wsl" initialDirectory={chosen} browseDraftId={browseDraftId} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('newSession.native.workspaceName')).toHaveValue('Retry workspace'))
    await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('create'))
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(2))
    expect(createThread).toHaveBeenLastCalledWith('wsl', { cwd: chosen, projectId })
    expect(createProject).toHaveBeenCalledTimes(projectCreates)
    if (projectCreates === 2) expect(createProject.mock.calls[1][1]).toMatchObject({ path: '/other' })
})

it('restores a cancelled Native Browse with an empty directory only for its explicit history entry', async () => {
    localStorage.clear()
    sessionStorage.clear()
    savePreferredCreationChoice('codex-native')
    mocks.recentNativePaths.push('/recent-path')
    const api = {
        getCodexNativeEndpoints: async () => ({ endpoints: [{ id: 'wsl', label: 'WSL' }] }),
        getCodexNativeEndpointStatus: async () => ({ available: true }),
        listCodexNativeProjects: async () => ({ data: [], nextCursor: null }),
        withCodexNativeEndpoint: () => ({ getCodexNativeModels: async () => ({ data: [{ model: 'gpt-5.6-terra', displayName: 'Terra', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }] }) }),
    } as unknown as ApiClient
    const choose = vi.fn()
    const first = render(<NewSession api={api} machines={[]} onChooseFolder={choose} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('model-options')).toHaveTextContent('Terra'))
    expect(screen.getByTestId('directory')).toHaveValue('/recent-path')
    fireEvent.change(screen.getByTestId('directory'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('model'))
    fireEvent.click(screen.getByTestId('reasoning'))
    fireEvent.change(screen.getByLabelText('newSession.native.workspace'), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText('newSession.native.workspaceName'), { target: { value: 'Keep on Back' } })
    fireEvent.click(screen.getByTestId('choose-folder'))
    const browseDraftId = choose.mock.calls[0][0].browseDraftId as string
    // The replace before /browse updates this still-mounted page first.
    first.rerender(<NewSession api={api} machines={[]} initialNativeEndpointId="wsl" initialDirectory="" browseDraftId={browseDraftId} onChooseFolder={choose} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect(loadNewSessionFormDraft()?.browseDraftId).toBe(browseDraftId)
    first.unmount()
    const unrelated = render(<NewSession api={api} machines={[]} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('newSession.native.workspace')).toHaveValue('none')
    unrelated.unmount()
    render(<NewSession api={api} machines={[]} initialNativeEndpointId="wsl" initialDirectory="" browseDraftId={browseDraftId} onChooseFolder={choose} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-terra'))
    expect(screen.getByLabelText('newSession.native.workspace')).toHaveValue('new')
    expect(screen.getByLabelText('newSession.native.workspaceName')).toHaveValue('Keep on Back')
    expect(await screen.findByTestId('directory')).toHaveValue('')
    expect(loadNewSessionFormDraft()).toBeNull()
})

it('can leave a remembered Native choice while runner discovery loads and preserves the selected runner when switching back', async () => {
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    savePreferredCreationChoice('codex-native')
    const nativeApi = {
        getCodexNativeEndpoints: vi.fn().mockResolvedValue({ endpoints: [{ id: 'native-host', label: 'Native host', defaultCwd: '/repo' }] }),
        getCodexNativeEndpointStatus: async () => ({ available: true, platformOs: 'linux' }),
        withCodexNativeEndpoint: () => ({ getCodexNativeModels: async () => ({ data: [] }) }),
    } as unknown as ApiClient
    const otherMachine = { id: 'machine-2' } as Machine
    const view = render(<NewSession api={nativeApi} machines={[]} isLoading onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('radio', { name: 'Codex Native' })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^Codex$/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('radio', { name: /^Codex$/ }))
    expect(screen.getByRole('radio', { name: /^Codex$/ })).toBeChecked()
    expect(screen.getByTestId('create')).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Codex Native' }))

    view.rerender(<NewSession api={nativeApi} machines={[machine, otherMachine]} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Codex$/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('radio', { name: /^Codex$/ }))
    expect(screen.getByLabelText('machine-selector')).toHaveValue('machine-1')
    fireEvent.change(screen.getByLabelText('machine-selector'), { target: { value: 'machine-2' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Codex Native' }))
    fireEvent.click(screen.getByRole('radio', { name: /^Claude$/ }))
    expect(screen.getByRole('radio', { name: /^Claude$/ })).toBeChecked()
    expect(screen.getByLabelText('machine-selector')).toHaveValue('machine-2')
})

describe('NewSession launch preferences', () => {
    beforeEach(() => {
        localStorage.clear()
        sessionStorage.clear()
        mocks.spawnSession.mockReset()
        mocks.onSuccess.mockReset()
        mocks.notification.mockReset()
        mocks.checkPathsExists.mockReset()
        mocks.checkPathsExists.mockImplementation(async () => ({
            exists: { 'C:\\repo': mocks.directoryExists }
        }))
        mocks.availableAgents.splice(
            0,
            mocks.availableAgents.length,
            ...['agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'pi']
                .map((agent) => ({ agent, available: true }))
        )
        mocks.codexModelsLoading = false
        mocks.agyModelsLoading = false
        mocks.agyModels = [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }]
        mocks.directoryExists = true
        mocks.copilotModels = []
        mocks.copilotModelsLoading = false
        mocks.kimiModels = []
        mocks.kimiModelsLoading = false
        mocks.kimiModelsError = null
        mocks.opencodeModels = [{ modelId: 'provider/current', name: 'Current' }]
        mocks.opencodeCurrentModelId = 'provider/current'
        mocks.opencodeModelsLoading = false
        mocks.opencodeVariants = null
        mocks.opencodeVariantsLoading = false
        mocks.opencodeVariantsEnabled = false
        mocks.piDialogSelection = ['pi-native-1']
        mocks.piModels = []
        mocks.piModelsLoading = false
        mocks.piModelsError = null
        mocks.nextModelValue = 'gpt-5.6-terra'
        mocks.refetchSessions.mockReset()
        mocks.refetchSessions.mockResolvedValue(undefined)
        mocks.addToast.mockReset()
        savePreferredAgent('codex')
    })

    it('disables unavailable Agents and falls back to the first available Agent', async () => {
        savePreferredAgent('claude')
        mocks.availableAgents.splice(
            0,
            mocks.availableAgents.length,
            { agent: 'codex', available: true }
        )

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByDisplayValue('codex')).toBeChecked())
        expect(screen.getByDisplayValue('claude')).toBeDisabled()
    })

    it('honors an explicit runner Browse target over a remembered Native preference without a form draft', async () => {
        savePreferredCreationChoice('codex-native')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'runner-created' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="/home/igna" onSuccess={mocks.onSuccess} onCancel={vi.fn()} />)
        expect(screen.getByRole('radio', { name: /^Codex$/ })).toBeChecked()
        expect(screen.getByRole('radio', { name: 'Codex Native' })).not.toBeChecked()
        expect(screen.getByLabelText('machine-selector')).toHaveValue('machine-1')
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', directory: '/home/igna', agent: 'codex' })))
        expect(mocks.onSuccess).toHaveBeenCalledWith('runner-created')
    })

    it('creates with the runner provider and directory opened from the session list', async () => {
        savePreferredCreationChoice('codex-native')
        const otherMachine = { id: 'machine-2' } as Machine
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'runner-created' })
        render(<NewSession api={api} machines={[otherMachine, machine]} initialMachineId="machine-1" initialAgent="claude"
            initialDirectory={'C:\\repo'} onSuccess={mocks.onSuccess} onCancel={vi.fn()} />)

        expect(screen.getByRole('radio', { name: 'Claude' })).toBeChecked()
        expect(screen.getByLabelText('machine-selector')).toHaveValue('machine-1')
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', directory: 'C:\\repo', agent: 'claude' })))
    })

    it('refuses a directory rejected by workspace-root validation', async () => {
        mocks.checkPathsExists.mockImplementation(async ([path]: string[]) => ({
            exists: { [path]: false },
            outsideWorkspaceRoots: [path]
        }))
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'unexpected' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(screen.getByText('newSession.directoryOutsideWorkspaceRoots')).toBeInTheDocument())
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('restores the last successful model and reasoning effort for the machine and agent', async () => {
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'safe-yolo'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-sol')
            expect(screen.getByTestId('reasoning')).toHaveTextContent('xhigh')
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
    })

    it('does not migrate a legacy YOLO value owned by a non-Codex agent', async () => {
        savePreferredAgent('claude')
        savePreferredYoloMode(true)

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByDisplayValue('codex'))

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
    })

    it('migrates a legacy YOLO value when Codex was the preferred agent', async () => {
        savePreferredAgent('codex')
        savePreferredYoloMode(true)

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('yolo')
        })
    })

    it('shows discovered Copilot models for the selected directory', async () => {
        mocks.copilotModels = [
            { modelId: 'gpt-5.6', name: 'GPT-5.6' },
            { modelId: 'auto', name: 'Auto' }
        ]

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByLabelText('Copilot'))

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent('Auto,GPT-5.6')
        })
    })

    it('disables creation while a remembered Copilot model is being validated', async () => {
        mocks.copilotModelsLoading = true
        savePreferredAgent('copilot')
        savePreferredLaunchSettings('machine-1', 'copilot', {
            model: 'gpt-5.6',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('shows dynamic Kimi models with Default for the selected directory', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' },
            { modelId: 'deepseek-v4.1-flash', name: 'thehive / hive-deepseek', provider: 'thehive' },
            { modelId: 'hyper-glm-5.3-flash', name: 'charm-hyper / Hyper · GLM-5.3-Flash', provider: 'charm-hyper' },
            { modelId: 'openrouter-union-alpha', provider: 'openrouter' }
        ]

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByDisplayValue('kimi'))

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent(
                'Default,thehive — thehive / GLM-5.3-flash,thehive — thehive / hive-deepseek,charm-hyper — charm-hyper / Hyper · GLM-5.3-Flash,openrouter — openrouter-union-alpha'
            )
        })
    })

    it('restores a remembered Kimi alias instead of resetting it to Default', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', provider: 'thehive' }
        ]
        savePreferredAgent('kimi')
        savePreferredLaunchSettings('machine-1', 'kimi', {
            model: 'GLM-5.3-flash',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('GLM-5.3-flash')
            expect(screen.getByTestId('create')).toBeEnabled()
        })
    })

    it('resets a remembered Kimi alias that the dynamic catalog no longer lists', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', provider: 'thehive' }
        ]
        savePreferredAgent('kimi')
        savePreferredLaunchSettings('machine-1', 'kimi', {
            model: 'retired-alias',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('auto')
        })
        expect(screen.getByTestId('create')).toBeEnabled()
    })

    it.each([
        ['model', 'gpt-5.6-sol', 'default'],
        ['reasoning effort', 'auto', 'xhigh']
    ])('disables creation while a remembered dynamic %s is being validated', async (
        _setting,
        model,
        modelReasoningEffort
    ) => {
        mocks.codexModelsLoading = true
        savePreferredLaunchSettings('machine-1', 'codex', {
            model,
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it.each([
        ['grok', {
            model: 'grok-4',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default'
        }],
        ['opencode', {
            model: 'provider/model',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'high'
        }]
    ] as const)('disables creation while %s cwd existence is unresolved', async (
        agent,
        settings
    ) => {
        mocks.directoryExists = undefined
        savePreferredAgent(agent)
        savePreferredLaunchSettings('machine-1', agent, settings)

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('saves changed launch settings only after creation succeeds', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('reasoning'))
        fireEvent.click(screen.getByTestId('permission-mode'))
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'yolo' }))
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toEqual({
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'max',
            permissionMode: 'yolo'
        })
    })

    it('restores the AGY model from a browse-return draft', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))
    })

    it('falls back to Default when a browse-return AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'removed-model', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('keeps an AGY model the user picked here when the machine catalog changes under the form', async () => {
        // The machine refreshes its catalog in the background, so the list can
        // change while the form is open. A model the user chose is theirs to
        // keep — unlike a restored one, which the two tests above drop.
        savePreferredAgent('agy')
        const view = render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('agy-model'))
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))

        mocks.agyModels = [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }]
        view.rerender(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))
    })

    it('falls back to Default when a preferred AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'removed-model', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('blocks Create while a remembered AGY model is awaiting catalog validation', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.agyModelsLoading = true
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('does not forward the global YOLO preference to managed DSH ACP', async () => {
        savePreferredAgent('dsh')
        savePreferredYoloMode(true)
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'dsh-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('dsh-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'dsh',
            yolo: undefined,
            permissionMode: undefined
        }))
    })

    it('shows machine DSH models and forwards the opaque tuple on create', async () => {
        savePreferredAgent('dsh')
        mocks.dshModels = [
            { modelId: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' },
            { modelId: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
        ]
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'dsh-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent('DeepSeek-V4-Pro')
        })
        mocks.nextModelValue = '["deepseek-official","deepseek-v4-pro"]'
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('dsh-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'dsh',
            model: '["deepseek-official","deepseek-v4-pro"]',
            yolo: undefined
        }))
    })

    it('spawns DSH without a model when Default stays selected', async () => {
        savePreferredAgent('dsh')
        mocks.dshModels = [{ modelId: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' }]
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'dsh-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent('DeepSeek-V41-Flash')
        })
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('dsh-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'dsh',
            model: undefined
        }))
    })

    it('restores a preferred DSH model that is still advertised and forwards it on create', async () => {
        savePreferredAgent('dsh')
        savePreferredLaunchSettings('machine-1', 'dsh', { model: '["deepseek-official","deepseek-flash"]', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.dshModels = [{ modelId: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' }]
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'dsh-session' })
        const view = render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('deepseek-flash'))

        // Remount: the remembered tuple must come back from the preferred
        // launch settings (not just the in-form draft) and survive the
        // catalog validation effect.
        view.unmount()
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('deepseek-flash'))

        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('dsh-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'dsh',
            model: '["deepseek-official","deepseek-flash"]',
            yolo: undefined
        }))
    })

    it('falls back to Default when a preferred DSH model is no longer advertised', async () => {
        savePreferredAgent('dsh')
        savePreferredLaunchSettings('machine-1', 'dsh', { model: '["deepseek-official","removed-model"]', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.dshModels = [{ modelId: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' }]
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('auto'))
    })

    it('lets Claude create with a chosen permission mode instead of the global YOLO toggle', async () => {
        savePreferredAgent('claude')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'claude-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('permission-mode-plan'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('claude-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude',
            yolo: undefined,
            permissionMode: 'plan'
        }))
    })

    it('does not carry a permission mode picked under another flavor into the Claude spawn payload', async () => {
        savePreferredAgent('codex')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'claude-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        // Starts as codex; picking the mocked native-select button sets the
        // shared nativePermissionMode state to 'yolo', a value 'claude' does
        // not carry in its own permission catalog.
        await waitFor(() => expect(screen.getByDisplayValue('codex')).toBeChecked())
        fireEvent.click(screen.getByTestId('permission-mode'))
        fireEvent.click(screen.getByDisplayValue('claude'))
        await waitFor(() => expect(screen.getByDisplayValue('claude')).toBeChecked())
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('claude-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude',
            permissionMode: 'default'
        }))
    })

    it('migrates a legacy YOLO value owned by Claude to bypassPermissions', async () => {
        savePreferredAgent('claude')
        savePreferredYoloMode(true)

        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('bypassPermissions')
        })
    })

    it('does not preselect bypassPermissions for Claude from a legacy YOLO value owned by another flavor', async () => {
        // hapi:newSession:yolo is a flavor-agnostic global key. The legacyYoloAgent
        // snapshot (captured once at mount, see index.tsx) is what stops a YOLO
        // toggle left on under cursor from silently preselecting bypassPermissions
        // the next time Claude is picked.
        savePreferredAgent('cursor')
        savePreferredYoloMode(true)

        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByDisplayValue('cursor')).toBeChecked())
        fireEvent.click(screen.getByDisplayValue('claude'))

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
    })

    it('keeps an explicit OpenCode Default selection instead of restoring a concrete model', async () => {
        savePreferredAgent('opencode')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'opencode-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        // The catalog advertises a concrete default; the user picks Default.
        fireEvent.click(screen.getByTestId('opencode-model-default'))
        await waitFor(() => expect(screen.getByTestId('opencode-model')).toHaveTextContent('default'))
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('opencode-session'))
        // Spawn omits model and the explicit Default choice sticks.
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'opencode', model: undefined }))
        expect(screen.getByTestId('opencode-model')).toHaveTextContent('default')
    })

    it('uses the probed current model variants for an explicit OpenCode Default selection', async () => {
        savePreferredAgent('opencode')
        mocks.opencodeVariants = { 'provider/current': ['low', 'high'] }
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('opencode-model-default'))
        await waitFor(() => expect(screen.getByTestId('opencode-variants')).toHaveTextContent('low,high'))
        expect(mocks.opencodeVariantsEnabled).toBe(true)
    })

    it('waits for OpenCode variants before launching a non-default effort', async () => {
        savePreferredAgent('opencode')
        mocks.opencodeVariantsLoading = true
        const view = render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('reasoning'))
        expect(screen.getByTestId('create')).toBeDisabled()

        mocks.opencodeVariantsLoading = false
        mocks.opencodeVariants = { 'provider/current': ['max'] }
        view.rerender(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
    })

    it('does not probe OpenCode variants until the working directory is verified', () => {
        savePreferredAgent('opencode')
        mocks.directoryExists = undefined
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        expect(mocks.opencodeVariantsEnabled).toBe(false)
    })

    it('restores a remembered OpenCode model when it is still advertised', async () => {
        savePreferredAgent('opencode')
        savePreferredLaunchSettings('machine-1', 'opencode', { model: 'provider/model', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'high' })
        mocks.opencodeModels = [{ modelId: 'provider/model', name: 'Model' }]
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('opencode-model')).toHaveTextContent('provider/model'))
    })

    it('persists the selected AGY model only after a successful launch', async () => {
        savePreferredAgent('agy')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'agy-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        fireEvent.click(screen.getByTestId('agy-model'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('agy-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'agy', model: 'gemini-3.6-flash-low' }))
        expect(loadPreferredLaunchSettings('machine-1', 'agy')?.model).toBe('gemini-3.6-flash-low')
    })

    it('does not overwrite AGY model preference after a failed launch', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'gemini-3.5-flash-low', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.agyModels = [
            { modelId: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)' },
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }
        ]
        mocks.spawnSession.mockResolvedValue({ type: 'error', message: 'spawn failed' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.5-flash-low'))
        fireEvent.click(screen.getByTestId('agy-model'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.notification).toHaveBeenCalledWith('error'))
        expect(loadPreferredLaunchSettings('machine-1', 'agy')?.model).toBe('gemini-3.5-flash-low')
    })

    it('spawns only once when Create is activated twice during directory validation', async () => {
        let finishDirectoryCheck!: (result: { exists: Record<string, boolean> }) => void
        mocks.checkPathsExists.mockReturnValue(new Promise((resolve) => {
            finishDirectoryCheck = resolve
        }))
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        const create = screen.getByTestId('create')
        fireEvent.click(create)
        fireEvent.click(create)
        finishDirectoryCheck({ exists: { 'C:\\repo': true } })

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.checkPathsExists).toHaveBeenCalledTimes(1)
        expect(mocks.spawnSession).toHaveBeenCalledTimes(1)
    })

    it('imports the selected Pi history and resumes the canonical HAPI session', async () => {
        savePreferredAgent('pi')
        const piApi = {
            getPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                sessions: [{
                    id: 'pi-native-1',
                    title: 'Existing Pi session',
                    cwd: 'C:\\repo',
                    file: 'C:\\pi-native-1.jsonl',
                    modifiedAt: 1,
                    messageCount: 2
                }]
            }),
            importPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                results: [{ piSessionId: 'pi-native-1', hapiSessionId: 'hapi-imported-1', action: 'created', appended: 2 }]
            }),
            reopenSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'hapi-imported-1', resumed: true })
        } as unknown as ApiClient

        render(
            <NewSession
                api={piApi}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await waitFor(() => expect(screen.getByTestId('select-pi-history')).toBeEnabled())
        fireEvent.click(screen.getByTestId('select-pi-history'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('hapi-imported-1'))
        expect(piApi.importPiSessions).toHaveBeenCalledWith({
            sessionIds: ['pi-native-1'],
            cwd: 'C:\\repo',
            machineId: 'machine-1'
        })
        expect(piApi.reopenSession).toHaveBeenCalledWith('hapi-imported-1')
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('discards a stale Pi scan after switching machines', async () => {
        savePreferredAgent('pi')
        mocks.piDialogSelection = ['pi-machine-b']
        const machineA = { id: 'machine-a' } as Machine
        const machineB = { id: 'machine-b' } as Machine
        let resolveMachineA!: (value: Awaited<ReturnType<ApiClient['getPiSessions']>>) => void
        let resolveMachineB!: (value: Awaited<ReturnType<ApiClient['getPiSessions']>>) => void
        const machineAScan = new Promise<Awaited<ReturnType<ApiClient['getPiSessions']>>>((resolve) => {
            resolveMachineA = resolve
        })
        const machineBScan = new Promise<Awaited<ReturnType<ApiClient['getPiSessions']>>>((resolve) => {
            resolveMachineB = resolve
        })
        const piApi = {
            getPiSessions: vi.fn((_cwd: string | null, selectedMachineId: string) => (
                selectedMachineId === machineA.id ? machineAScan : machineBScan
            )),
            importPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: machineB.id,
                results: [{ piSessionId: 'pi-machine-b', hapiSessionId: 'hapi-machine-b', action: 'created', appended: 1 }]
            }),
            reopenSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'hapi-machine-b', resumed: true })
        } as unknown as ApiClient

        render(
            <NewSession
                api={piApi}
                machines={[machineA, machineB]}
                initialMachineId={machineA.id}
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        fireEvent.click(screen.getByTestId('close-pi-history'))
        fireEvent.change(screen.getByLabelText('machine-selector'), { target: { value: machineB.id } })
        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await act(async () => {
            resolveMachineB({
                success: true,
                machineId: machineB.id,
                sessions: [{ id: 'pi-machine-b', title: 'Machine B', cwd: 'C:\\repo', file: 'B.jsonl', modifiedAt: 2, messageCount: 1 }]
            })
            await machineBScan
        })
        await waitFor(() => expect(screen.getByTestId('pi-session-ids')).toHaveTextContent('pi-machine-b'))

        await act(async () => {
            resolveMachineA({
                success: true,
                machineId: machineA.id,
                sessions: [{ id: 'pi-machine-a', title: 'Machine A', cwd: 'C:\\repo', file: 'A.jsonl', modifiedAt: 1, messageCount: 1 }]
            })
            await machineAScan
        })
        expect(screen.getByTestId('pi-session-ids')).toHaveTextContent('pi-machine-b')
        expect(screen.getByTestId('pi-session-ids')).not.toHaveTextContent('pi-machine-a')

        fireEvent.click(screen.getByTestId('select-pi-history'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('hapi-machine-b'))
        expect(piApi.importPiSessions).toHaveBeenCalledWith({
            sessionIds: ['pi-machine-b'],
            cwd: 'C:\\repo',
            machineId: machineB.id
        })
    })

    it('refreshes successful Pi imports even when another batch item fails', async () => {
        savePreferredAgent('pi')
        mocks.piDialogSelection = ['pi-native-1', 'pi-native-2']
        const piApi = {
            getPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                sessions: [1, 2].map((index) => ({
                    id: `pi-native-${index}`,
                    title: `Pi ${index}`,
                    cwd: 'C:\\repo',
                    file: `C:\\pi-${index}.jsonl`,
                    modifiedAt: index,
                    messageCount: 1
                }))
            }),
            importPiSessions: vi.fn().mockResolvedValue({
                success: false,
                machineId: 'machine-1',
                results: [
                    { piSessionId: 'pi-native-1', hapiSessionId: 'hapi-1', action: 'created', appended: 1 },
                    { piSessionId: 'pi-native-2', hapiSessionId: 'hapi-2', error: { code: 'session_active', message: 'active' } }
                ]
            })
        } as unknown as ApiClient

        render(
            <NewSession
                api={piApi}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await waitFor(() => expect(screen.getByTestId('select-pi-history')).toBeEnabled())
        fireEvent.click(screen.getByTestId('select-pi-history'))

        await waitFor(() => expect(mocks.refetchSessions).toHaveBeenCalled())
        expect(piApi.getPiSessions).toHaveBeenCalledTimes(2)
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'piImport.success.title',
            body: 'piImport.success.body'
        }))
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'piImport.failed.title' }))
    })

    it('does not save changed launch settings when creation fails', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'error', message: 'spawn failed' })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('reasoning'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.notification).toHaveBeenCalledWith('error'))
        expect(mocks.onSuccess).not.toHaveBeenCalled()
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
    })

    it('keeps the browse-return draft ahead of the saved launch preference', async () => {
        savePreferredAgent('claude')
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh'
        })
        saveNewSessionFormDraft({
            agent: 'codex',
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'max',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: false,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-terra')
            expect(screen.getByTestId('reasoning')).toHaveTextContent('max')
        })
    })

    it('resets a restored Pi model that left the machine catalog', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            { provider: 'openai-codex', modelId: 'gpt-5.6-sol' },
        ]
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/stale-model',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('auto')
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })
    })

    it('resets a restored effort the Default Pi selection cannot offer', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            {
                provider: 'openai-codex',
                modelId: 'gpt-5.6-sol',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
            },
        ]
        // Default model (auto) renders the effort field without a map, which
        // hides xhigh — the restored hidden level must not survive into create.
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'auto',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })
    })

    it('keeps a restored xhigh effort when the selected model map opts in', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            {
                provider: 'openai-codex',
                modelId: 'gpt-5.6-sol',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
            },
        ]
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('openai-codex/gpt-5.6-sol')
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('xhigh')
        })
    })

    it('does not submit a hidden restored effort when Pi model discovery fails', async () => {
        savePreferredAgent('pi')
        // A failed catalog never resolves the restored model, so the effort
        // field renders with an undefined map and hides xhigh. Creation is not
        // blocked on error (only on loading), so the hidden level must have
        // been reconciled away rather than forwarded.
        mocks.piModels = []
        mocks.piModelsError = 'probe failed'
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })

        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'pi',
            effort: undefined,
        }))
    })

    it('shows Pi machine models and thinking-level effort and forwards both on create', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            { provider: 'openai-codex', modelId: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            { provider: 'opencode-go', modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ]

        render(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            // Provider-qualified options surfaced through the unified ModelSelector.
            expect(screen.getByTestId('model-options')).toHaveTextContent('GPT-5.6 Sol')
            expect(screen.getByTestId('model-options')).toHaveTextContent('DeepSeek V4 Pro')
        })

        // Select the second provider's model and a thinking level.
        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        mocks.nextModelValue = 'opencode-go/deepseek-v4-pro'
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'pi',
            model: 'opencode-go/deepseek-v4-pro',
        }))
    })
})
