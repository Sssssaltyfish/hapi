import type { ResponseAnnotation } from '@/lib/responseAnnotations'
import { useTranslation } from '@/lib/use-translation'

export function ResponseAnnotationCards({ annotations, onRemove, onAnnotationChange }: {
    annotations: readonly ResponseAnnotation[]
    onRemove?: (index: number) => void
    onAnnotationChange?: (index: number, annotation: string) => void
}) {
    const { t } = useTranslation()
    if (annotations.length === 0) return null
    return <div className="flex min-w-0 flex-col gap-1.5 text-xs" data-testid="response-annotation-cards">
        {annotations.map((annotation, index) => <div key={index}
            className="flex min-w-0 items-start gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-2.5 py-2">
            <span aria-hidden="true" className="shrink-0 text-[var(--app-hint)]">“</span>
            <div className="min-w-0 flex-1">
                <div data-hapi-nested-scroll="true" className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[var(--app-fg)]">{annotation.text}</div>
                {onAnnotationChange ? <label className="mt-2 flex flex-col gap-1">
                    <span className="text-[var(--app-hint)]">{t('message.quoteNotes', { index: index + 1 })}</span>
                    <textarea
                        aria-label={t('message.quoteNotes', { index: index + 1 })}
                        placeholder={t('message.quoteNotesPlaceholder')}
                        value={annotation.annotation ?? ''}
                        rows={2}
                        data-hapi-nested-scroll="true"
                        className="max-h-32 min-h-10 w-full resize-y rounded-md border border-[var(--app-border)] bg-transparent px-2 py-1 text-xs leading-5 text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                        onChange={event => onAnnotationChange(index, event.target.value)}
                        onKeyDown={event => event.stopPropagation()}
                    />
                </label> : annotation.annotation ? <div className="mt-1 whitespace-pre-wrap text-[var(--app-hint)]">{annotation.annotation}</div> : null}
            </div>
            {onRemove ? <button type="button" className="shrink-0 px-1 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                aria-label={t('message.removeQuote')} onClick={() => onRemove(index)}>×</button> : null}
        </div>)}
    </div>
}
