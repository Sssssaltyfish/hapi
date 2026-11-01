import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import type { ScheduledMessage } from '@/lib/scheduledMessage'
import { useTranslation } from '@/lib/use-translation'

export function ScheduledMessageCard({ message }: { message: ScheduledMessage }) {
    const { t } = useTranslation()
    const label = <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{t('message.scheduledTask')}</span>
        {message.kind === 'trigger'
            ? <time dateTime={message.time} title={new Date(message.time).toLocaleString()}>
                {new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
            : <span>· {t(message.decision === 'DONT_NOTIFY' ? 'message.scheduledQuiet' : 'message.scheduledNotify')}</span>}
    </span>
    if (message.kind === 'trigger') return <details className="min-w-0" data-testid="scheduled-message">
        <summary className="cursor-pointer text-xs text-[var(--app-hint)]">{label}</summary>
        <div className="mt-2 min-w-0 border-l-2 border-[var(--app-divider)] pl-3 text-sm">
            <MarkdownRenderer content={message.text} />
        </div>
    </details>
    return <div className="min-w-0" data-testid="scheduled-message">
        {label}
        <div className="mt-1 min-w-0"><MarkdownRenderer content={message.text} /></div>
    </div>
}
