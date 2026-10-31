import type { ReactNode } from 'react'
import { useTranslation } from '@/lib/use-translation'

/** Presentation shared by the HAPI queue and the daemon-owned native queue. */
export function QueuedMessagesFrame({ count, children, notice }: { count: number; children: ReactNode; notice?: ReactNode }) {
    const { t } = useTranslation()
    return <div role="status" aria-label={`${count} queued message${count === 1 ? '' : 's'} pending invocation`} className="mx-auto w-full max-w-content">
        <div className="px-3 pb-0 pt-2 text-sm text-[var(--app-fg-muted)]">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--app-hint)]">
                <svg className="h-[14px] w-[14px] shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" /><path d="M8 5v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{t('queuedMessages.title')}</span>
            </div>
            {notice}
            <ul className="flex max-h-32 flex-col gap-1.5 overflow-y-auto sm:max-h-48" aria-label="Queued messages">{children}</ul>
        </div>
    </div>
}
