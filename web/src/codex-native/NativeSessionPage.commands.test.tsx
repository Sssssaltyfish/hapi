import type { ComponentProps } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ApiError, type ApiClient } from '@/api/client'
import type { AttachmentMetadata, Session } from '@/types/api'
import type { SessionChat } from '@/components/SessionChat'
import { serializeResponseAnnotations, splitResponseAnnotations } from '@/lib/responseAnnotations'
import { NativeSessionPage } from './NativeSessionPage'

type ChatProps = ComponentProps<typeof SessionChat>
const { ui, thread, queue } = vi.hoisted(() => ({
    ui: { props: null as ChatProps | null },
    thread: { items: [], requests: [], connected: true, detail: { activeTurn: { id: 'active-turn', status: 'inProgress' } },
        subscribeEvents: () => () => {}, latest: vi.fn(), refreshDetail: vi.fn(), applySettings: vi.fn(), historyResetRevision: 0 },
    queue: { items: [], refresh: vi.fn() },
}))
vi.mock('@/components/SessionChat', () => ({ SessionChat: (props: ChatProps) => { ui.props = props; return null } }))
vi.mock('./useNativeThread', () => ({ useNativeThread: () => thread }))
vi.mock('./useNativeQueue', () => ({ useNativeQueue: () => queue }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: [] }) }))
beforeEach(() => { ui.props = null; vi.clearAllMocks() })
const state = { capabilities: { plan: true, goal: true }, collaborationMode: { mode: 'default' }, goal: null, planPresets: [], unavailable: {} }
const session = { id: 'native-session', metadata: { flavor: 'codex', nativeCodex: { threadId: 'native-thread', endpointId: 'test' } } } as Session
function setup(post = vi.fn().mockResolvedValue({ command: 'goal', action: 'show', goal: null })) {
    const api = { getCodexNativeCommands: vi.fn().mockResolvedValue(state), codexNativeCommand: post,
        getCodexNativeEndpoints: vi.fn().mockResolvedValue({ endpoints: [] }), codexNativeAction: vi.fn(),
        getConversationCacheScope: () => ({ key: 'test' }), withCodexNativeEndpoint: () => api }
    render(<I18nProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NativeSessionPage api={api as unknown as ApiClient} session={session} onBack={() => {}} />
    </QueryClientProvider></I18nProvider>)
    return api
}

it('runs management commands without a chat message, queue mutation or new model turn', async () => {
    const api = setup()
    await waitFor(() => expect(api.getCodexNativeCommands).toHaveBeenCalled())
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!('/goal')).toBe('handled') })
    expect(api.codexNativeCommand).toHaveBeenCalledWith('native-thread', { command: { command: 'goal', action: 'show' } })
    expect(api.codexNativeAction).not.toHaveBeenCalled()
    expect(queue.refresh).not.toHaveBeenCalled()
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!(`/goal ${'😀'.repeat(4000)}`)).toBe('handled') })
    expect(api.codexNativeCommand).toHaveBeenCalledTimes(2)
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!(`/goal ${'😀'.repeat(4001)}`)).toBe('failed') })
    expect(api.codexNativeCommand).toHaveBeenCalledTimes(2)
})

it('submits a quoted plan prompt once through the queue command even when explicit steer was requested', async () => {
    const post = vi.fn().mockResolvedValue({ command: 'plan', applied: { collaborationMode: { mode: 'plan' } }, submission: { accepted: true } })
    const api = setup(post)
    const annotations = [{ text: 'Selected', annotation: 'Keep note', source: { messageId: 'source', startOffset: 0, endOffset: 8 } }]
    const text = serializeResponseAnnotations('/plan Explain this', annotations)
    await act(async () => { expect(await ui.props!.onSend(text, [{ path: '/native/file' }] as AttachmentMetadata[], null, 'steer')).toBeTruthy() })
    expect(post).toHaveBeenCalledOnce()
    const request = post.mock.calls[0][1]
    expect(request.command.command).toBe('plan')
    expect(splitResponseAnnotations(request.command.prompt)).toEqual({ body: 'Explain this', annotations })
    expect(request.attachments).toEqual([{ path: '/native/file' }])
    expect(request.expectedTurnId).toBeUndefined()
    expect(api.codexNativeAction).not.toHaveBeenCalled()
})

it('does not resend an unconfirmed plan submission until the user explicitly permits another attempt', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError('unconfirmed', 502, undefined, JSON.stringify({ submission: { accepted: false, outcome: 'unconfirmed' } })))
    setup(post)
    await act(async () => { expect(await ui.props!.onSend('/plan Investigate')).toBe(false) })
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!('/plan Investigate')).toBe('failed') })
    expect(ui.props!.sendError?.restoreSuppressed).toBe(true)
    await act(async () => { expect(await ui.props!.onSend('/plan Investigate')).toBe(false) })
    expect(post).toHaveBeenCalledOnce()
    expect(ui.props!.sendError?.text).toBe('/plan Investigate')
    expect(ui.props!.sendError?.action).toBeTruthy()
    expect(queue.refresh).toHaveBeenCalledOnce()
})
