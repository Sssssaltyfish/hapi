import { useCallback, useMemo, useRef } from 'react'
import { serializeResponseAnnotations, splitResponseAnnotations } from '@/lib/responseAnnotations'

/** The original composer text remains the single persisted/send/retry payload. */
export function useResponseAnnotationDraft(
    text: string,
    writeText: (text: string) => void,
) {
    const latest = useRef(text)
    latest.current = text
    const projected = useMemo(() => splitResponseAnnotations(text), [text])
    const setBody = useCallback((body: string) => {
        const current = splitResponseAnnotations(latest.current)
        const next = serializeResponseAnnotations(body, current.annotations)
        latest.current = next
        writeText(next)
    }, [writeText])
    const remove = useCallback((index: number) => {
        const current = splitResponseAnnotations(latest.current)
        const next = serializeResponseAnnotations(current.body, current.annotations.filter((_, position) => position !== index))
        latest.current = next
        writeText(next)
    }, [writeText])
    const setAnnotation = useCallback((index: number, annotation: string) => {
        const current = splitResponseAnnotations(latest.current)
        if (!current.annotations[index]) return
        const next = serializeResponseAnnotations(current.body, current.annotations.map((entry, position) => {
            if (position !== index) return entry
            const { annotation: _previousNote, ...selection } = entry
            return annotation ? { ...selection, annotation } : selection
        }))
        latest.current = next
        writeText(next)
    }, [writeText])
    return { ...projected, setBody, remove, setAnnotation }
}
