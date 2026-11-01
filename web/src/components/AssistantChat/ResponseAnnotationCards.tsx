import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResponseAnnotation } from '@/lib/responseAnnotations'
import { useTranslation } from '@/lib/use-translation'
import { useResponseAnnotationSession } from './ResponseAnnotationSession'

function QuoteNotes({ value, label, placeholder, onChange }: {
    value: string
    label: string
    placeholder: string
    onChange: (value: string) => void
}) {
    const ref = useRef<HTMLTextAreaElement>(null)
    useLayoutEffect(() => {
        const input = ref.current
        if (!input) return
        const resize = () => {
            input.style.height = 'auto'
            const style = window.getComputedStyle(input)
            const borders = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0)
            input.style.height = `${input.scrollHeight + borders}px`
        }
        resize()
        let width = input.clientWidth
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
            if (width === input.clientWidth) return
            width = input.clientWidth
            resize()
        })
        observer?.observe(input)
        return () => observer?.disconnect()
    }, [value])
    return <textarea ref={ref} aria-label={label} placeholder={placeholder}
        value={value} rows={1} data-hapi-nested-scroll="true"
        className="mt-1 max-h-32 min-h-7 w-full resize-none overflow-y-auto rounded-md border border-[var(--app-border)] bg-transparent px-2 py-0.5 text-xs leading-5 text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => event.stopPropagation()} />
}

export function ResponseAnnotationCards({ annotations, onRemove, onAnnotationChange, onNavigate, onNavigateStart, onNavigateError }: {
    annotations: readonly ResponseAnnotation[]
    onRemove?: (index: number) => void
    onAnnotationChange?: (index: number, annotation: string) => void
    onNavigate?: () => void
    onNavigateStart?: () => void
    onNavigateError?: () => void
}) {
    const { t } = useTranslation()
    const session = useResponseAnnotationSession()
    const [pending, setPending] = useState<number | null>(null)
    const [failed, setFailed] = useState<number | null>(null)
    const request = useRef<AbortController | null>(null)
    useEffect(() => () => request.current?.abort(), [])
    const navigate = async (annotation: ResponseAnnotation, index: number) => {
        request.current?.abort()
        const controller = new AbortController()
        request.current = controller
        setPending(index); setFailed(null)
        onNavigateStart?.()
        try { await session?.navigate(annotation, controller.signal); if (!controller.signal.aborted) onNavigate?.() }
        catch { if (!controller.signal.aborted) { setFailed(index); onNavigateError?.() } }
        finally { if (!controller.signal.aborted) setPending(null) }
    }
    if (annotations.length === 0) return null
    return <div className="flex min-w-0 flex-col gap-1 text-xs" data-testid="response-annotation-cards">
        {annotations.map((annotation, index) => <div key={index}
            className="flex min-w-0 items-start gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-2 py-1.5 sm:px-2.5 sm:py-2">
            <span aria-hidden="true" className="shrink-0 text-[var(--app-hint)]">“</span>
            <div className="min-w-0 flex-1">
                {session && annotation.source ? <button type="button" data-hapi-nested-scroll="true"
                    aria-label={t('message.quoteOriginal')} aria-busy={pending === index}
                    onClick={() => void navigate(annotation, index)}
                    className="block max-h-16 w-full overflow-y-auto whitespace-pre-wrap break-words text-left leading-4 text-[var(--app-fg)] hover:text-[var(--app-link)] sm:max-h-24 sm:leading-5">{annotation.text}</button>
                    : <div data-hapi-nested-scroll="true" className="max-h-16 overflow-y-auto whitespace-pre-wrap break-words leading-4 text-[var(--app-fg)] sm:max-h-24 sm:leading-5">{annotation.text}</div>}
                {failed === index ? <div role="status" className="mt-1 text-[var(--app-hint)]">{t('session.outline.locateFailed')}</div> : null}
                {onAnnotationChange ? <QuoteNotes
                        label={t('message.quoteNotes', { index: index + 1 })}
                        placeholder={t('message.quoteNotesPlaceholder')}
                        value={annotation.annotation ?? ''}
                        onChange={value => onAnnotationChange(index, value)}
                    /> : annotation.annotation ? <div className="mt-1 whitespace-pre-wrap text-[var(--app-hint)]">{annotation.annotation}</div> : null}
            </div>
            {onRemove ? <button type="button" className="shrink-0 px-1 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                aria-label={t('message.removeQuote')} onClick={() => onRemove(index)}>×</button> : null}
        </div>)}
    </div>
}
