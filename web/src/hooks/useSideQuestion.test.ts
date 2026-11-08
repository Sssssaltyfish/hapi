import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useSideQuestion } from './useSideQuestion'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

function client() {
    return {
        getConversationCacheScope: () => ({ key: 'test' }),
        askSideQuestion: vi.fn(),
        cancelSideQuestion: vi.fn().mockResolvedValue({ canceled: true }),
        sendMessage: vi.fn(),
    }
}

describe('useSideQuestion', () => {
    it('keeps a hidden request and its answer outside the main send path', async () => {
        const api = client()
        const answer = deferred<{ text: string }>()
        api.askSideQuestion.mockReturnValue(answer.promise)
        const { result } = renderHook(() => useSideQuestion(api as unknown as ApiClient, 'source'))
        act(() => result.current.ask('Why this change?'))
        act(() => result.current.close())
        expect(result.current.visible).toBe(false)
        expect(api.cancelSideQuestion).not.toHaveBeenCalled()
        await act(async () => answer.resolve({ text: 'Because…' }))
        expect(result.current.result?.text).toBe('Because…')
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('does not let a canceled request replace a newer answer', async () => {
        const api = client()
        const old = deferred<{ text: string }>()
        api.askSideQuestion.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ text: 'New answer' })
        const { result } = renderHook(() => useSideQuestion(api as unknown as ApiClient, 'source'))
        act(() => result.current.ask('First'))
        await act(async () => result.current.cancel())
        act(() => result.current.ask('Second'))
        await waitFor(() => expect(result.current.result?.text).toBe('New answer'))
        await act(async () => old.resolve({ text: 'Late old answer' }))
        expect(result.current.result?.text).toBe('New answer')
        expect(api.cancelSideQuestion).toHaveBeenCalledOnce()
    })

    it('cancels only the side request when leaving the conversation', () => {
        const api = client()
        api.askSideQuestion.mockReturnValue(new Promise(() => {}))
        const { result, unmount } = renderHook(() => useSideQuestion(api as unknown as ApiClient, 'source'))
        act(() => result.current.ask('Question'))
        const payload = api.askSideQuestion.mock.calls[0][1]
        unmount()
        expect(api.cancelSideQuestion).toHaveBeenCalledWith('source', payload.clientId)
        expect(api.sendMessage).not.toHaveBeenCalled()
    })
})
