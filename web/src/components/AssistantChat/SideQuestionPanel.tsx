import { useLayoutEffect, useRef, useState } from 'react'
import { CloseIcon, LoaderIcon } from '@/components/icons'
import { MessageSquareIcon } from '@/components/ToolCard/icons'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { useTranslation } from '@/lib/use-translation'
import type { useSideQuestion } from '@/hooks/useSideQuestion'

export function SideQuestionPanel({ sideQuestion, disabled }: {
    sideQuestion: ReturnType<typeof useSideQuestion>
    disabled: boolean
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState('')
    const input = useRef<HTMLTextAreaElement>(null)
    const { open, visible, result } = sideQuestion
    useLayoutEffect(() => {
        const element = input.current
        if (!element) return
        element.style.height = 'auto'
        element.style.height = `${Math.min(element.scrollHeight, 128)}px`
    }, [draft, open, visible, result?.pending])
    if (!open) return null

    if (!visible) return <div className="mx-auto flex w-full max-w-content items-center gap-2 py-1 text-xs text-[var(--app-hint)]">
        <button type="button" onClick={sideQuestion.show} className="flex min-h-8 min-w-0 items-center gap-2 hover:text-[var(--app-fg)]">
            {result?.pending ? <LoaderIcon className="size-3.5 shrink-0 animate-spin" /> : <MessageSquareIcon className="size-3.5 shrink-0" />}
            <span className="shrink-0">/btw</span><span className="truncate">{result?.question}</span>
        </button>
    </div>

    const submit = () => {
        if (disabled || result?.pending || !draft.trim()) return
        sideQuestion.ask(draft)
        setDraft('')
    }
    const iconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40'
    return <section aria-label={t('sideQuestion.title')} className="mx-auto mb-2 w-full max-w-content rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2">
        <div className="flex items-center gap-2">
            <MessageSquareIcon className="size-3.5 text-[var(--app-hint)]" />
            <span className="flex-1 text-xs font-medium">/btw</span>
            {result?.pending && <button type="button" className={iconButton} aria-label={t('sideQuestion.cancel')} disabled={result.canceling} onClick={() => void sideQuestion.cancel()}>
                {result.canceling ? <LoaderIcon className="size-3.5 animate-spin" /> : <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>}
            </button>}
            <button type="button" className={iconButton} aria-label={t('sideQuestion.minimize')} onClick={sideQuestion.hide}><svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg></button>
            <button type="button" className={iconButton} aria-label={t('button.close')} onClick={sideQuestion.close}><CloseIcon className="size-4" /></button>
        </div>
        {result && <div className="max-h-[min(35dvh,20rem)] overflow-y-auto overscroll-contain py-1 text-sm">
            <p className="mb-2 whitespace-pre-wrap break-words text-[var(--app-hint)]">{result.question}</p>
            {result.pending && <span role="status" aria-label={t('sideQuestion.pending')}><LoaderIcon className="size-4 animate-spin text-[var(--app-hint)]" /></span>}
            {result.text && <MarkdownRenderer content={result.text} standalone />}
            {result.error && <p role="alert" className="whitespace-pre-wrap break-words text-[var(--app-hint)]">{result.error}</p>}
        </div>}
        {!result?.pending && <form className="mt-1 flex items-end gap-2" onSubmit={event => { event.preventDefault(); submit() }}>
            <textarea ref={input} rows={1} value={draft} onChange={event => setDraft(event.target.value)}
                autoFocus={!result} aria-label={t('sideQuestion.placeholder')} placeholder={t('sideQuestion.placeholder')}
                className="hapi-composer-field min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none"
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
            <button type="submit" aria-label={t('sideQuestion.send')} disabled={disabled || !draft.trim()}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-30"><svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5m-7 7 7-7 7 7" /></svg></button>
        </form>}
    </section>
}
