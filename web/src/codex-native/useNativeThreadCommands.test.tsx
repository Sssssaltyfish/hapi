import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { NativeEvent } from './types'
import type { NativeCommandState } from './nativeThreadCommands'
import { useNativeThreadCommands } from './useNativeThreadCommands'

const initial: NativeCommandState = { capabilities: { plan: true, goal: true }, planPresets: [], collaborationMode: { mode: 'default' }, goal: null, unavailable: {} }
function setup(api: object) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let listener: (event: NativeEvent) => void = () => {}
    const subscribe = (next: typeof listener) => { listener = next; return () => {} }
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider>
    const hook = renderHook(() => useNativeThreadCommands(api as ApiClient, 'thread', 'test-endpoint', true, subscribe), { wrapper })
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
