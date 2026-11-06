import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { ApiError, type ApiClient } from '@/api/client'
import type { NativeEvent } from './types'
import type { NativeCommandState } from './nativeThreadCommands'
import { NativeCommandInactiveError, NativeRecapCanceledError, useNativeThreadCommands } from './useNativeThreadCommands'

const initial: NativeCommandState = { capabilities: { plan: true, goal: true }, planPresets: [], collaborationMode: { mode: 'default' }, goal: null, unavailable: {} }
function setup(api: object) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let listener: (event: NativeEvent) => void = () => {}
    const subscribe = (next: typeof listener) => { listener = next; return () => {} }
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider>
    const hook = renderHook(({ threadId }) => useNativeThreadCommands(api as ApiClient, threadId, 'test-endpoint', true, subscribe), { wrapper, initialProps: { threadId: 'thread' } })
    return { ...hook, event: (event: NativeEvent) => listener(event) }
}
it('rejects a pre-ACK read without SSE and keeps the command successful if its follow-up read fails', async () => {
    let oldRead!: (state: NativeCommandState) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve })).mockRejectedValue(new Error('read offline'))
    const post = vi.fn().mockResolvedValue({ command: 'plan', applied: { collaborationMode: { mode: 'plan' } } })
    const { result } = setup({ getCodexNativeCommands: read, codexNativeCommand: post })
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    await act(async () => { await result.current.execute({ command: { command: 'plan', mode: 'plan' } }) })
    await act(async () => oldRead(initial))
    await waitFor(() => expect(result.current.readError).toBeTruthy())
    expect(result.current.state).toBeUndefined()
    expect(result.current.feedback).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenCalledOnce()
})
it('refreshes goal/settings after external daemon events and never retries a command mutation', async () => {
    const updated = { ...initial, collaborationMode: { mode: 'plan' }, goal: { threadId: 'thread', objective: 'Actual goal', status: 'paused', tokenBudget: 1234, tokensUsed: 45, timeUsedSeconds: 6, createdAt: 1, updatedAt: 2 } }
    const read = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(updated)
    const post = vi.fn().mockRejectedValue(new Error('mutation unavailable'))
    const { result, event } = setup({ getCodexNativeCommands: read, codexNativeCommand: post })
    await waitFor(() => expect(result.current.state).toEqual(initial))
    act(() => event({ method: 'thread/goal/updated', params: { threadId: 'thread', goal: updated.goal } }))
    await waitFor(() => expect(result.current.state?.goal?.tokenBudget).toBe(1234))
    expect(read).toHaveBeenCalledOnce()
    await act(async () => { await expect(result.current.execute({ command: { command: 'goal', action: 'resume' } })).rejects.toThrow('mutation unavailable') })
    expect(post).toHaveBeenCalledOnce()
    expect(result.current.state?.goal?.status).toBe('paused')
    expect(result.current.feedback?.error).toBe(true)
})

it('keeps independent command results when responses arrive in reverse order', async () => {
    let finishRecap!: (result: unknown) => void
    const post = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRecap = resolve }))
        .mockResolvedValueOnce({ command: 'compact' })
    const { result } = setup({ getCodexNativeCommands: vi.fn().mockResolvedValue(initial), codexNativeCommand: post })
    await waitFor(() => expect(result.current.state).toEqual(initial))
    let recap!: Promise<unknown>
    act(() => { recap = result.current.execute({ command: { command: 'recap' } }) })
    await act(async () => { await result.current.execute({ command: { command: 'compact' } }) })
    expect(result.current.pending).toBe(true)
    expect(result.current.managementResult?.command).toBe('compact')
    await act(async () => { finishRecap({ command: 'recap', text: 'Earlier request' }); await recap })
    expect(result.current.pending).toBe(false)
    act(() => result.current.dismissManagementResult())
    expect(result.current.managementResult).toEqual({ command: 'recap', text: 'Earlier request' })
})

it('finishes a status read after at most one re-read while newer goal counters keep arriving', async () => {
    let first!: (state: NativeCommandState) => void
    let second!: (state: NativeCommandState) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
        .mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
    const { result, event } = setup({ getCodexNativeCommands: read })
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    const goal = { threadId: 'thread', objective: 'Keep working', status: 'active', tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 }
    act(() => event({ method: 'thread/goal/updated', params: { goal } }))
    await act(async () => first(initial))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    act(() => event({ method: 'thread/goal/updated', params: { goal: { ...goal, tokensUsed: 10 } } }))
    act(() => event({ method: 'thread/goal/updated', params: { goal: { ...goal, tokensUsed: 20 } } }))
    await act(async () => second(initial))
    await waitFor(() => expect(result.current.state?.goal?.tokensUsed).toBe(20))
    expect(result.current.loading).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
})

it('keeps a hidden recap available without reopening it or consuming a simultaneous usage result', async () => {
    let finish!: (value: unknown) => void
    const post = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        .mockResolvedValueOnce({ command: 'usage', snapshot: { marker: 'usage' } })
    const cancel = vi.fn()
    const { result, event } = setup({ getCodexNativeCommands: vi.fn().mockResolvedValue(initial), codexNativeCommand: post, cancelCodexNativeRecap: cancel })
    let recap!: Promise<unknown>
    act(() => { recap = result.current.execute({ command: { command: 'recap' } }) })
    const clientId = post.mock.calls[0][1].clientId
    expect(clientId).toMatch(/^[\da-f-]{36}$/i)
    act(() => result.current.hideRecap(clientId))
    await act(async () => { await result.current.execute({ command: { command: 'usage' } }) })
    expect(result.current.managementResult?.command).toBe('usage')
    act(() => event({ method: 'thread/settings/updated', params: { settings: { collaborationMode: { mode: 'plan' } } } }))
    await act(async () => { finish({ command: 'recap', text: 'Original snapshot', sourceTurnId: 'original-turn' }); await recap })
    expect(result.current.managementResult?.command).toBe('usage')
    expect(result.current.recaps).toMatchObject([{ clientId, hidden: true, ready: true }])
    expect(cancel).not.toHaveBeenCalled()
    const dismissUsage = result.current.dismissManagementResult
    act(() => result.current.showRecap(clientId))
    expect(result.current.managementResult).toMatchObject({ command: 'recap', text: 'Original snapshot', sourceTurnId: 'original-turn' })
    const dismissRecap = result.current.dismissManagementResult
    act(() => dismissRecap())
    expect(result.current.managementResult?.command).toBe('usage')
    act(() => dismissRecap())
    expect(result.current.managementResult?.command).toBe('usage')
    expect(result.current.recaps).toEqual([])
    act(() => dismissUsage())
    expect(result.current.managementResult).toBeNull()
})

it('cancels the exact recap run and accepts the cancellation error before its acknowledgement', async () => {
    let rejectStart!: (error: unknown) => void
    let finishCancel!: (response: { canceled: boolean }) => void
    const post = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStart = reject }))
        .mockResolvedValueOnce({ command: 'compact', accepted: true })
    const cancel = vi.fn().mockImplementation(() => new Promise(resolve => { finishCancel = resolve }))
    const { result } = setup({ getCodexNativeCommands: vi.fn().mockResolvedValue(initial), codexNativeCommand: post, cancelCodexNativeRecap: cancel })
    let recap!: Promise<unknown>
    act(() => { recap = result.current.execute({ command: { command: 'recap' } }).catch(error => error) })
    const clientId = post.mock.calls[0][1].clientId
    let cancellation!: Promise<void>
    act(() => { cancellation = result.current.cancelRecap(clientId) })
    expect(cancel).toHaveBeenCalledWith('thread', clientId)
    await act(async () => { rejectStart(new ApiError('Recap was canceled.', 409)); expect(await recap).toBeInstanceOf(NativeRecapCanceledError) })
    await act(async () => { finishCancel({ canceled: true }); await cancellation })
    expect(result.current.recaps).toEqual([])
    expect(result.current.managementResult).toBeNull()
    expect(result.current.feedback).toBeNull()
    await act(async () => { await result.current.execute({ command: { command: 'compact' } }) })
    expect(result.current.managementResult?.command).toBe('compact')
})

it.each([true, false])('settles a recap result racing its cancellation acknowledgement: canceled=%s', async canceled => {
    let finishStart!: (value: unknown) => void
    let finishCancel!: (response: { canceled: boolean }) => void
    const post = vi.fn().mockImplementation(() => new Promise(resolve => { finishStart = resolve }))
    const cancel = vi.fn().mockImplementation(() => new Promise(resolve => { finishCancel = resolve }))
    const { result } = setup({ getCodexNativeCommands: vi.fn().mockResolvedValue(initial), codexNativeCommand: post, cancelCodexNativeRecap: cancel })
    let recap!: Promise<unknown>
    act(() => { recap = result.current.execute({ command: { command: 'recap' } }) })
    const clientId = post.mock.calls[0][1].clientId
    let cancellation!: Promise<void>
    act(() => { cancellation = result.current.cancelRecap(clientId) })
    await act(async () => { finishStart({ command: 'recap', text: 'Captured snapshot', sourceTurnId: 'old-turn' }); await recap })
    expect(result.current.managementResult).toBeNull()
    await act(async () => { finishCancel({ canceled }); await cancellation })
    if (canceled) {
        expect(result.current.recaps).toEqual([])
        expect(result.current.managementResult).toBeNull()
    } else expect(result.current.managementResult).toMatchObject({ command: 'recap', text: 'Captured snapshot' })
})

it('ignores late recap and cancellation responses after navigating to another thread', async () => {
    let finishStart!: (value: unknown) => void
    let finishCancel!: (response: { canceled: boolean }) => void
    const post = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishStart = resolve }))
        .mockResolvedValueOnce({ command: 'compact', accepted: true })
    const cancel = vi.fn().mockImplementation(() => new Promise(resolve => { finishCancel = resolve }))
    const { result, rerender } = setup({ getCodexNativeCommands: vi.fn().mockResolvedValue(initial), codexNativeCommand: post, cancelCodexNativeRecap: cancel })
    let recap!: Promise<unknown>, cancellation!: Promise<void>
    act(() => { recap = result.current.execute({ command: { command: 'recap' } }).catch(error => error) })
    act(() => { cancellation = result.current.cancelRecap(post.mock.calls[0][1].clientId) })
    rerender({ threadId: 'other-thread' })
    await act(async () => { await result.current.execute({ command: { command: 'compact' } }) })
    await act(async () => { finishStart({ command: 'recap', text: 'Old thread', sourceTurnId: 'old-turn' }); expect(await recap).toBeInstanceOf(NativeCommandInactiveError); finishCancel({ canceled: true }); await cancellation })
    expect(result.current.recaps).toEqual([])
    expect(result.current.managementResult?.command).toBe('compact')
    expect(result.current.feedback).toBeNull()
})
