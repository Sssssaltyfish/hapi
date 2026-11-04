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
    expect(result.current.getText()).toBe(sent)
    // A local rerender may still expose assistant-ui's previous snapshot before
    // the imperative editor write reaches its subscribed React state.
    rerender({ text: original })
    expect(result.current.getText()).toBe(sent)
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

it('edits notes independently while preserving every source and clears only the chosen note', () => {
    const source = { messageId: 'opaque-native-id', startOffset: 4, endOffset: 12 }
    const annotations = [{ text: 'Selected', source }, { text: 'Another selection', annotation: 'Existing note' }]
    const write = vi.fn()
    const { result } = renderHook(() => useResponseAnnotationDraft(serializeResponseAnnotations('Keep body', annotations), write))
    act(() => {
        result.current.setAnnotation(0, 'Explain this\n中文 note')
        result.current.setAnnotation(1, '')
    })
    expect(splitResponseAnnotations(write.mock.calls.at(-1)![0])).toEqual({
        body: 'Keep body',
        annotations: [{ text: 'Selected', source, annotation: 'Explain this\n中文 note' }, { text: 'Another selection' }],
    })
})
