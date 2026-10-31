import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useResponseAnnotationDraft } from './useResponseAnnotationDraft'
import { serializeResponseAnnotations, splitResponseAnnotations } from '@/lib/responseAnnotations'

it('keeps native annotation payload in persisted text while body edits and failed-send restores remain editable', () => {
    const annotations = [{ text: 'Selected', source: { messageId: 'native-id', startOffset: 0, endOffset: 8 } }]
    const original = serializeResponseAnnotations('Draft', annotations)
    const write = vi.fn()
    const { result, rerender } = renderHook(({ text }) => useResponseAnnotationDraft(text, write), { initialProps: { text: original } })
    expect(result.current.body).toBe('Draft')
    act(() => result.current.setBody('Edited draft'))
    const sent = write.mock.calls.at(-1)![0]
    expect(splitResponseAnnotations(sent)).toEqual({ body: 'Edited draft', annotations })
    // assistant-ui clears on send, then existing failure/draft restore writes
    // the complete rejected payload through its ordinary text path.
    rerender({ text: '' })
    expect(result.current.annotations).toEqual([])
    rerender({ text: sent })
    expect(result.current.body).toBe('Edited draft')
    expect(result.current.annotations).toEqual(annotations)
    act(() => result.current.remove(0))
    expect(write).toHaveBeenLastCalledWith('Edited draft')
})
