import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { ResponseAnnotation } from '@/lib/responseAnnotations'
import { useTranslation } from '@/lib/use-translation'
import { ResponseAnnotationCards } from './ResponseAnnotationCards'
import { useResponseAnnotationSession } from './ResponseAnnotationSession'

const ResponseAnnotationsContext = createContext<readonly ResponseAnnotation[] | { annotations: readonly ResponseAnnotation[]; partId?: string } | undefined>(undefined)
export const ResponseAnnotationsProvider = ResponseAnnotationsContext.Provider

export function ResponseAnnotationReference({ index, children }: { index: number; children: ReactNode }) {
    const context = useContext(ResponseAnnotationsContext)
    const session = useResponseAnnotationSession()
    const annotations = context && 'annotations' in context ? context.annotations : context
    const partId = context && 'annotations' in context ? context.partId : undefined
    const [resolved, setResolved] = useState<readonly ResponseAnnotation[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [failed, setFailed] = useState(false)
    const [open, setOpen] = useState(false)
    const request = useRef<AbortController | null>(null)
    const openIntent = useRef(0)
    const trigger = useRef<HTMLButtonElement>(null)
    const navigating = useRef(false)
    useEffect(() => {
        setResolved(null); setFailed(false); setLoading(false); setOpen(false)
        return () => { openIntent.current++; request.current?.abort() }
    }, [partId])
    const cancelOpening = useCallback(() => {
        openIntent.current++
        request.current?.abort()
        setLoading(false)
        setOpen(false)
    }, [])
    useEffect(() => {
        if (!loading) return
        const cancelOutside = (event: Event) => {
            if (event.target instanceof Node && !trigger.current?.contains(event.target)) cancelOpening()
        }
        document.addEventListener('pointerdown', cancelOutside, true)
        document.addEventListener('focusin', cancelOutside, true)
        return () => {
            document.removeEventListener('pointerdown', cancelOutside, true)
            document.removeEventListener('focusin', cancelOutside, true)
        }
    }, [loading, cancelOpening])
    const load = async () => {
        if (!session || !partId || annotations?.[index - 1] || resolved?.[index - 1]) return
        request.current?.abort()
        const controller = new AbortController()
        request.current = controller
        setLoading(true); setFailed(false)
        try {
            const value = await session.resolver.readAnnotations(partId, controller.signal)
            if (!controller.signal.aborted) setResolved(value)
        }
        catch { if (!controller.signal.aborted) setFailed(true) }
        finally { if (!controller.signal.aborted) setLoading(false) }
    }
    const changeOpen = async (value: boolean) => {
        if (!value || loading) {
            cancelOpening()
            return
        }
        const intent = ++openIntent.current
        // Resolve the quote before placing its popover. Replacing a small
        // loading panel after placement moves the card underneath the pointer.
        await load()
        if (openIntent.current === intent) setOpen(true)
    }
    const { t } = useTranslation()
    // Documents and user-authored examples outside an assistant reply remain literal.
    if (!context) return <>{children}</>
    const annotation = annotations?.[index - 1] ?? resolved?.[index - 1]
    return <Popover.Root open={open} onOpenChange={value => { void changeOpen(value) }}>
        <Popover.Trigger asChild>
            <button ref={trigger} type="button" aria-label={t('message.quoteReference', { index })} aria-busy={loading}
                onKeyDown={event => { if (event.key === 'Escape' && loading) { event.preventDefault(); void changeOpen(false) } }}
                className="mx-0.5 inline-flex rounded px-1 align-super text-[0.7em] font-medium leading-none text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]">
                [{index}]
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12}
                onOpenAutoFocus={event => event.preventDefault()}
                onCloseAutoFocus={event => {
                    // Restoring the old trigger after a history jump makes the
                    // browser scroll back, overriding the exact range reveal.
                    if (navigating.current) event.preventDefault()
                    navigating.current = false
                }}
                className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 sm:p-2 text-xs shadow-lg">
                {annotation ? <ResponseAnnotationCards annotations={[annotation]}
                    onNavigateStart={() => { navigating.current = true }}
                    onNavigateError={() => { navigating.current = false }}
                    onNavigate={() => setOpen(false)} />
                    : <div className="p-2 text-xs text-[var(--app-hint)]" role="status">{loading ? t('loading') : t('message.quoteReferenceUnavailable')}
                        {failed || !loading ? <button type="button" onClick={() => void load()} className="ml-2 text-[var(--app-link)]">{t('button.retry')}</button> : null}
                    </div>}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>
}
