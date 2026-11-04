import { createContext, useContext, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { ResponseAnnotation } from '@/lib/responseAnnotations'
import { useTranslation } from '@/lib/use-translation'
import { ResponseAnnotationCards } from './ResponseAnnotationCards'

const ResponseAnnotationsContext = createContext<readonly ResponseAnnotation[] | undefined>(undefined)
export const ResponseAnnotationsProvider = ResponseAnnotationsContext.Provider

export function ResponseAnnotationReference({ index, children }: { index: number; children: ReactNode }) {
    const annotations = useContext(ResponseAnnotationsContext)
    const { t } = useTranslation()
    // Documents and user-authored examples outside an assistant reply remain literal.
    if (!annotations) return <>{children}</>
    const annotation = annotations[index - 1]
    return <Popover.Root>
        <Popover.Trigger asChild>
            <button type="button" aria-label={t('message.quoteReference', { index })}
                className="mx-0.5 inline-flex rounded px-1 align-super text-[0.7em] font-medium leading-none text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]">
                [{index}]
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12}
                onOpenAutoFocus={event => event.preventDefault()}
                className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm shadow-lg">
                <div className="mb-2 text-xs font-medium text-[var(--app-hint)]">{t('message.quoteReference', { index })}</div>
                {annotation ? <ResponseAnnotationCards annotations={[annotation]} />
                    : <p className="text-xs text-[var(--app-hint)]">{t('message.quoteReferenceUnavailable')}</p>}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>
}
