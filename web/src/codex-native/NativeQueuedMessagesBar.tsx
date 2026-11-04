import { useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { QueuedMessagesFrame } from '@/components/AssistantChat/QueuedMessagesFrame'
import { splitResponseAnnotations } from '@/lib/responseAnnotations'
import { useTranslation } from '@/lib/use-translation'
import { record } from './presentation'
import type { useNativeQueue } from './useNativeQueue'

export function NativeQueuedMessagesBar({ api, threadId, queue, connected, activeTurnId }: {
    api: ApiClient; threadId: string; queue: ReturnType<typeof useNativeQueue>; connected: boolean; activeTurnId: string | null
}) {
    const { t } = useTranslation()
    const [pending, setPending] = useState<string | null>(null)
    const [error, setError] = useState('')
    const [steered, setSteered] = useState<ReadonlySet<string>>(new Set())
    const [cleanupError, setCleanupError] = useState<{ id: string; message: string } | null>(null)
    useEffect(() => {
        if (queue.error || !connected) return
        const ids = new Set(queue.items.map(item => item.id))
        setSteered(previous => {
            const next = new Set([...previous].filter(id => ids.has(id)))
            return next.size === previous.size ? previous : next
        })
    }, [queue.items, queue.error, connected])
    const cleanupNotice = cleanupError && queue.items.some(item => item.id === cleanupError.id)
        ? `${t('nativeQueue.steerCleanupFailed')} ${cleanupError.message}` : ''
    if (!queue.items.length && !queue.error && !error) return null
    const act = async (id: string, action: 'queue/delete' | 'queue/steer') => {
        if (pending || !connected) return
        if (action === 'queue/steer' && (!activeTurnId || steered.has(id))) return
        setPending(id); setError('')
        try {
            const result = await api.codexNativeAction(threadId, action, {
                queuedSubmissionId: id,
                ...(action === 'queue/steer' ? { expectedTurnId: activeTurnId } : {}),
            })
            if (action === 'queue/steer') {
                if (result.accepted !== true) throw new Error(t('queuedMessages.steerFailed'))
                setSteered(previous => new Set([...previous, id]))
                setCleanupError(typeof result.cleanupError === 'string' ? { id, message: result.cleanupError } : null)
            }
        }
        catch (error) { setError(String(error)) }
        finally { await queue.refresh(); setPending(null) }
    }
    return <QueuedMessagesFrame count={queue.items.length} notice={
        (error || queue.error || cleanupNotice || !connected) && <p role="alert" className="mb-1 text-xs text-[var(--app-hint)]">{error || queue.error || cleanupNotice || t('nativeQueue.disconnected')}</p>
    }>
        {queue.items.map(item => {
            const id = typeof item.id === 'string' ? item.id : ''
            const input = Array.isArray(item.input) ? item.input.map(record) : []
            const text = input.filter(value => value.type === 'text').map(value => String(value.text ?? '')).join('\n')
            const annotated = splitResponseAnnotations(text)
            const attachments = input.filter(value => ['image', 'localImage', 'file'].includes(String(value.type)))
            return <li key={id} className="flex min-w-0 items-start gap-2 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm">
                <div className="min-w-0 flex-1">
                    <span className="whitespace-pre-wrap break-words text-[var(--app-fg)]">{annotated.body}</span>
                    {annotated.annotations.length > 0 && <div className="text-xs text-[var(--app-hint)]">{t('nativeQueue.quotes', { count: annotated.annotations.length })}</div>}
                    {attachments.length > 0 && <div className="text-xs text-[var(--app-hint)]">{t('nativeQueue.attachments', { count: attachments.length })}</div>}
                    {steered.has(id) && <div className="text-xs text-[var(--app-hint)]" title={t('queuedMessages.steeredBadgeTitle')}>{t('queuedMessages.steeredBadge')}</div>}
                </div>
                <button type="button" aria-label={t('queuedMessages.steer')} title={t('queuedMessages.steer')}
                    disabled={!id || !!pending || !connected || !activeTurnId || steered.has(id)}
                    onClick={() => void act(id, 'queue/steer')} onMouseDown={event => event.preventDefault()}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-border)] disabled:opacity-40">
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                        <path d="M9.5 1 3 9h3.8L6 15l6.5-8H8.7L9.5 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                </button>
                <button type="button" aria-label={t('nativeQueue.cancel')} disabled={!id || !!pending || !connected}
                    onClick={() => void act(id, 'queue/delete')} onMouseDown={event => event.preventDefault()}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-border)] disabled:opacity-40">×</button>
            </li>
        })}
    </QueuedMessagesFrame>
}
