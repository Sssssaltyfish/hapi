import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { QueuedMessagesFrame } from '@/components/AssistantChat/QueuedMessagesFrame'
import { splitResponseAnnotations } from '@/lib/responseAnnotations'
import { useTranslation } from '@/lib/use-translation'
import { record } from './presentation'
import type { useNativeQueue } from './useNativeQueue'

export function NativeQueuedMessagesBar({ api, threadId, queue, connected }: {
    api: ApiClient; threadId: string; queue: ReturnType<typeof useNativeQueue>; connected: boolean
}) {
    const { t } = useTranslation()
    const [pending, setPending] = useState<string | null>(null)
    const [error, setError] = useState('')
    if (!queue.items.length && !queue.error && !error) return null
    const cancel = async (id: string) => {
        if (pending || !connected) return
        setPending(id); setError('')
        try { await api.codexNativeAction(threadId, 'queue/delete', { queuedSubmissionId: id }) }
        catch (error) { setError(String(error)) }
        finally { await queue.refresh(); setPending(null) }
    }
    return <QueuedMessagesFrame count={queue.items.length} notice={
        (error || queue.error || !connected) && <p role="alert" className="mb-1 text-xs text-[var(--app-hint)]">{error || queue.error || t('nativeQueue.disconnected')}</p>
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
                </div>
                <button type="button" aria-label={t('nativeQueue.cancel')} disabled={!id || !!pending || !connected}
                    onClick={() => void cancel(id)} onMouseDown={event => event.preventDefault()}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-border)] disabled:opacity-40">×</button>
            </li>
        })}
    </QueuedMessagesFrame>
}
