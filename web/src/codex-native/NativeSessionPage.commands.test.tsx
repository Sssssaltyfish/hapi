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
import type { NativeItemEntry } from './types'
import { normalizeCodexUsage } from '@hapi/protocol/codexUsage'

type ChatProps = ComponentProps<typeof SessionChat>
const { ui, thread, queue } = vi.hoisted(() => ({
    ui: { props: null as ChatProps | null },
    thread: { items: [] as NativeItemEntry[], includesLiveTail: true, requests: [], connected: true, detail: { activeTurn: { id: 'active-turn', status: 'inProgress' } },
        subscribeEvents: () => () => {}, latest: vi.fn(), refreshDetail: vi.fn(), applySettings: vi.fn(), historyResetRevision: 0 },
    queue: { items: [], refresh: vi.fn() },
}))
vi.mock('@/components/SessionChat', () => ({ SessionChat: (props: ChatProps) => { ui.props = props; return null } }))
vi.mock('./useNativeThread', () => ({ useNativeThread: () => thread }))
vi.mock('./useNativeQueue', () => ({ useNativeQueue: () => queue }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: [] }) }))
beforeEach(() => {
    ui.props = null
    thread.items = []
    thread.detail = { activeTurn: { id: 'active-turn', status: 'inProgress' } }
    vi.clearAllMocks()
})
const state = { capabilities: { plan: true, goal: true }, collaborationMode: { mode: 'default' }, goal: null, planPresets: [], unavailable: {} }
const session = { id: 'native-session', metadata: { flavor: 'codex', nativeCodex: { threadId: 'native-thread', endpointId: 'test' } } } as Session
function setup(post = vi.fn().mockResolvedValue({ command: 'goal', action: 'show', goal: null })) {
    const api = { getCodexNativeCommands: vi.fn().mockResolvedValue(state), codexNativeCommand: post,
        getCodexNativeEndpoints: vi.fn().mockResolvedValue({ endpoints: [] }), codexNativeAction: vi.fn(),
        getConversationCacheScope: () => ({ key: 'test' }), withCodexNativeEndpoint: () => api }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = () => <I18nProvider><QueryClientProvider client={client}>
        <NativeSessionPage api={api as unknown as ApiClient} session={session} onBack={() => {}} />
    </QueryClientProvider></I18nProvider>
    const { rerender } = render(view())
    return Object.assign(api, { refreshView: () => rerender(view()) })
}

it.each([
    { threadSettings: undefined, expected: 'xhigh' },
    { threadSettings: { model: 'gpt-6-astra', effort: 'high' }, expected: 'high' },
    { threadSettings: { model: 'gpt-6-astra', effort: null }, expected: null },
])('uses read metadata until a live settings snapshot exists: $expected', async ({ threadSettings, expected }) => {
    Object.assign(thread.detail, { thread: { id: 'native-thread', model: 'gpt-6-astra', reasoningEffort: 'xhigh' },
        ...(threadSettings ? { threadSettings } : {}) })
    const api = setup()
    await waitFor(() => expect(api.getCodexNativeCommands).toHaveBeenCalled())
    expect(ui.props!.session.model).toBe('gpt-6-astra')
    expect(ui.props!.session.modelReasoningEffort).toBe(expected)
    expect(api.codexNativeAction).not.toHaveBeenCalled()
})

it('runs management commands without a chat message, queue mutation or new model turn', async () => {
    const api = setup()
    await waitFor(() => expect(api.getCodexNativeCommands).toHaveBeenCalled())
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!('/goal')).toBe('handled') })
    expect(api.codexNativeCommand).toHaveBeenCalledWith('native-thread', { command: { command: 'goal', action: 'show' } })
    expect(api.codexNativeAction).not.toHaveBeenCalled()
    expect(queue.refresh).not.toHaveBeenCalled()
    for (const objective of ['pause', 'resume', 'clear', 'show']) {
        await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!(`/goal ${objective}`)).toBe('handled') })
        expect(api.codexNativeCommand).toHaveBeenLastCalledWith('native-thread', { command: { command: 'goal', action: 'set', objective } })
    }
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!(`/goal ${'😀'.repeat(4000)}`)).toBe('handled') })
    expect(api.codexNativeCommand).toHaveBeenCalledTimes(6)
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!(`/goal ${'😀'.repeat(4001)}`)).toBe('failed') })
    expect(api.codexNativeCommand).toHaveBeenCalledTimes(6)
})

it('shows a pending send, then accepts its daemon echo even if the POST response is lost', async () => {
    const api = setup()
    const post = Promise.withResolvers<unknown>()
    api.codexNativeAction.mockReturnValue(post.promise)
    let submission!: ReturnType<ChatProps['onSend']>
    await act(async () => { submission = ui.props!.onSend('hello') })
    const id = api.codexNativeAction.mock.calls[0][2].clientId
    expect(ui.props!.messages).toMatchObject([{ id, status: 'sending' }])
    // Two clients can send identical text. Only an echo with our ID counts.
    const entry = (id: string, clientId: string): NativeItemEntry => ({
        item: { type: 'userMessage', id, clientId, content: [{ type: 'text', text: 'hello' }] },
    })
    thread.items = [entry('desktop', 'elsewhere')]
    api.refreshView()
    expect(ui.props!.messages).toHaveLength(2)
    thread.items = [...thread.items, entry('daemon', id)]
    api.refreshView()
    expect(ui.props!.messages.map(m => m.id)).toEqual(['native:desktop', 'native:daemon'])
    await act(async () => { post.reject(new Error('connection lost')); expect(await submission).toEqual({ attemptId: id }) })
    expect(ui.props!.sendError).toBeNull()
})

it('dispatches the four native commands without chat input or discovery refresh and rejects extra text', async () => {
    const post = vi.fn().mockImplementation(async (_id, request) => ({ ...request.command,
        ...(request.command.command === 'compact' ? { accepted: true }
            : request.command.command === 'recap' ? { sourceTurnId: 'turn', text: 'Recap' }
                : request.command.command === 'usage' ? { snapshot: normalizeCodexUsage(null, null) }
                    : { denial: null }) }))
    const api = setup(post)
    await waitFor(() => expect(api.getCodexNativeCommands).toHaveBeenCalledOnce())
    for (const command of ['compact', 'recap', 'usage', 'approve']) {
        await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!(`/${command}`)).toBe('handled') })
    }
    expect(post).toHaveBeenCalledTimes(4)
    expect(api.getCodexNativeCommands).toHaveBeenCalledOnce()
    expect(api.codexNativeAction).not.toHaveBeenCalled()
    expect(queue.refresh).not.toHaveBeenCalled()
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!('/compact unexpected')).toBe('failed') })
    await act(async () => { expect(await ui.props!.onSend('/recap unexpected')).toBe(false) })
    expect(post).toHaveBeenCalledTimes(4)
    expect(api.codexNativeAction).not.toHaveBeenCalled()
})

it('treats an explicitly canceled recap as handled so the composer does not restore its command', async () => {
    const api = setup(vi.fn().mockRejectedValue(new ApiError('Recap was canceled.', 409, undefined, JSON.stringify({ error: 'Recap was canceled.' }))))
    await waitFor(() => expect(api.getCodexNativeCommands).toHaveBeenCalledOnce())
    await act(async () => { expect(await ui.props!.nativeCapabilities!.onSubmitCommand!('/recap')).toBe('handled') })
    expect(api.codexNativeCommand).toHaveBeenCalledWith('native-thread', { command: { command: 'recap' }, clientId: expect.any(String) })
    expect(api.codexNativeAction).not.toHaveBeenCalled()
})

it.each(['Explain this', 'off'])('submits a quoted plan prompt %s once through the queue command even when explicit steer was requested', async prompt => {
    const post = vi.fn().mockResolvedValue({ command: 'plan', applied: { collaborationMode: { mode: 'plan' } }, submission: { accepted: true } })
    const api = setup(post)
    const annotations = [{ text: 'Selected', annotation: 'Keep note', source: { messageId: 'source', startOffset: 0, endOffset: 8 } }]
    const text = serializeResponseAnnotations(`/plan ${prompt}`, annotations)
    await act(async () => { expect(await ui.props!.onSend(text, [{ path: '/native/file' }] as AttachmentMetadata[], null, 'steer')).toBeTruthy() })
    expect(post).toHaveBeenCalledOnce()
    const request = post.mock.calls[0][1]
    expect(request.command.command).toBe('plan')
    expect(splitResponseAnnotations(request.command.prompt)).toEqual({ body: prompt, annotations })
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
