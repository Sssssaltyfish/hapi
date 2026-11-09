import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionSchema } from '@hapi/protocol/schemas'
import type { ApiClient } from '@/api/client'
import { NativeSessionPage } from './NativeSessionPage'

vi.mock('@tanstack/react-router', async importOriginal => ({ ...await importOriginal<typeof import('@tanstack/react-router')>(), useNavigate: () => vi.fn() }))
vi.mock('@/components/AgentTerminal/AgentTerminalView', () => ({ AgentTerminalView: () => null }))

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

it('renders native content after the native model catalogue reaches the existing chat controls', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
    // jsdom has no layout. Give the real virtualizer a visible viewport so this
    // integration test exercises message rendering alongside native controls.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(390)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 600))
    HTMLElement.prototype.scrollTo = vi.fn()
    const session = SessionSchema.parse({ id: 'codex-native:test:native-thread', namespace: 'test', seq: 0, createdAt: 1000, updatedAt: 2000,
        active: true, activeAt: 2000, metadataVersion: 1, agentStateVersion: 1, thinking: false, thinkingAt: 0, agentState: {},
        metadata: { flavor: 'codex', name: 'Native chat', host: 'Test daemon', path: '/tmp', nativeCodex: { endpointId: 'test', threadId: 'native-thread', available: true } }, model: 'gpt-6-astra', modelReasoningEffort: 'ultra' })
    let nativeSettings: Record<string, unknown> = { model: 'gpt-6-astra', effort: 'ultra', approvalsReviewer: 'auto_review', approvalPolicy: { granular: { sandbox_approval: true } }, sandboxPolicy: { type: 'readOnly' } }
    const codexNativeAction = vi.fn(async (_id: string, _action: string, patch: Record<string, unknown>) => {
        nativeSettings = { ...nativeSettings, ...patch }
        return { applied: nativeSettings }
    })
    const uploadCodexNativeFile = vi.fn(async (_id: string, filename: string) => ({ success: true, path: `native-upload:${filename}` }))
    const api = {
        codexNativeAction,
        uploadCodexNativeFile,
        deleteCodexNativeUpload: vi.fn(async () => ({ success: true })),
        withCodexNativeEndpoint: () => api,
        getConversationCacheScope: () => ({ key: 'native-render', persistent: false }),
        getCodexNativeThread: async () => ({ thread: { id: 'native-thread', name: 'Native chat', status: { type: 'idle' } } }),
        getCodexNativeActiveTurn: async () => ({ activeTurn: null }),
        getCodexNativeQueue: async () => ({ data: [], nextCursor: null }),
        getCodexNativeItems: async () => ({ data: [
            { turnId: 'turn', item: { id: 'desktop-skill', type: 'userMessage', content: [
                { type: 'text', text: '[$native-leading](/workspace/skill folder/SKILL.md) Read this.' },
                { type: 'skill', name: 'native-leading', path: '/workspace/skill folder/SKILL.md' },
            ] }, startedAtMs: 1998 },
            { turnId: 'turn', item: { id: 'legacy-skill', type: 'userMessage', content: [
                { type: 'text', text: 'Use **the selected skill ' },
                { type: 'skill', name: 'native-inline', path: 'C:\\skill folder\\with (parens)\\SKILL.md' },
                { type: 'text', text: ' now** to inspect $variable.' },
            ] }, startedAtMs: 1999 },
            { turnId: 'turn', item: { id: 'response', type: 'agentMessage', text: 'Native message renders here' }, startedAtMs: 2000, completedAtMs: 2001 },
        ], nextCursor: null }),
        getCodexNativeModels: async () => ({ data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'Astra', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }, { reasoningEffort: 'ultra', description: 'Ultra' }] }] }),
        streamCodexNativeEvents: (_id: string, _signal: AbortSignal, onEvent: (event: unknown) => void) => {
            onEvent({ method: 'hapi/ready', params: { thread: { id: 'native-thread', name: 'Native chat', status: { type: 'idle' } }, threadSettings: nativeSettings } })
            return new Promise<void>(() => {})
        },
        getSessions: async () => ({ sessions: [] }), getMachines: async () => ({ machines: [] }),
        fetchTranscriptionProviders: async () => ({ providers: [] }),
    }
    render(<I18nProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider>
        <NativeSessionPage api={api as unknown as ApiClient} session={session} onBack={() => {}} />
    </ToastProvider></QueryClientProvider></I18nProvider>)
    expect(await screen.findByText('Native message renders here')).toBeInTheDocument()
    expect(screen.getByText('Approve for me')).toBeInTheDocument()
    expect(screen.getByTitle('$native-leading')).toHaveClass('rounded-full')
    expect(screen.getByTitle('$native-inline')).toHaveClass('rounded-full')
    expect(screen.getByText(/to inspect \$variable/)).toBeInTheDocument()
    expect((await screen.findAllByText('Astra')).length).toBeGreaterThan(0)
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning Effort: Ultra' }))
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    await waitFor(() => expect(codexNativeAction).toHaveBeenCalledWith('native-thread', 'settings', { effort: 'medium' }))
    expect(await screen.findByRole('button', { name: 'Reasoning Effort: Medium' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByLabelText('Ask for approval')).toHaveValue('')
    expect(screen.getByLabelText('Approval reviewer')).toHaveValue('auto_review')
    expect(screen.queryByRole('button', { name: 'Yolo' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Approval reviewer'), { target: { value: 'user' } })
    await waitFor(() => expect(codexNativeAction).toHaveBeenCalledWith('native-thread', 'settings', { approvalsReviewer: 'user' }))
    await waitFor(() => expect(screen.getByLabelText('Approval reviewer')).toHaveValue('user'))
    expect(screen.getAllByText('Ask for approval').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Ask for approval')).toHaveValue('')
    expect(screen.getByText('Sandbox: Read only')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Ask for approval'), { target: { value: 'never' } })
    expect(await screen.findByText('Read only')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled()
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { types: ['Files'], files: [
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        new File(['image'], 'proof.png', { type: 'image/png' }),
    ] } })
    await waitFor(() => expect(uploadCodexNativeFile).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(codexNativeAction).toHaveBeenCalledWith('native-thread', 'messages', expect.objectContaining({
        text: '', attachments: expect.arrayContaining([
            expect.objectContaining({ filename: 'notes.txt', path: 'native-upload:notes.txt' }),
            expect.objectContaining({ filename: 'proof.png', path: 'native-upload:proof.png' }),
        ])
    })))
})
