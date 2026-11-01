import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
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
    useEffect(() => { setResolved(null); setFailed(false); return () => request.current?.abort() }, [partId])
    const load = async () => {
        if (!session || !partId || annotations?.[index - 1] || resolved?.[index - 1]) return
        request.current?.abort()
        const controller = new AbortController()
        request.current = controller
        setLoading(true); setFailed(false)
        try { setResolved(await session.resolver.readAnnotations(partId, controller.signal)) }
        catch { if (!controller.signal.aborted) setFailed(true) }
        finally { if (!controller.signal.aborted) setLoading(false) }
    }
    const { t } = useTranslation()
    // Documents and user-authored examples outside an assistant reply remain literal.
    if (!context) return <>{children}</>
    const annotation = annotations?.[index - 1] ?? resolved?.[index - 1]
    return <Popover.Root open={open} onOpenChange={value => { setOpen(value); if (value) void load(); else { request.current?.abort(); setLoading(false) } }}>
        <Popover.Trigger asChild>
            <button type="button" aria-label={t('message.quoteReference', { index })}
                className="mx-0.5 inline-flex rounded px-1 align-super text-[0.7em] font-medium leading-none text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]">
                [{index}]
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12}
                onOpenAutoFocus={event => event.preventDefault()}
                className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 sm:p-2 text-xs shadow-lg">
                {annotation ? <ResponseAnnotationCards annotations={[annotation]} onNavigate={() => setOpen(false)} />
                    : <div className="p-2 text-xs text-[var(--app-hint)]" role="status">{loading ? t('loading') : t('message.quoteReferenceUnavailable')}
                        {failed || !loading ? <button type="button" onClick={() => void load()} className="ml-2 text-[var(--app-link)]">{t('button.retry')}</button> : null}
                    </div>}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>
}
