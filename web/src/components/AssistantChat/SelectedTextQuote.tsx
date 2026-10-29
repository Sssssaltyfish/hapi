import { useEffect, useState, type RefObject } from 'react'
import { useAui, useAuiState } from '@assistant-ui/react'
import { useTranslation } from '@/lib/use-translation'

export function SelectedTextQuote({ scope }: { scope: RefObject<HTMLElement | null> }) {
    const api = useAui()
    const draft = useAuiState(state => state.composer.text)
    const { t } = useTranslation()
    const [text, setText] = useState('')
    useEffect(() => {
        const update = () => {
            const selection = window.getSelection()
            const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement
            const start = element(selection?.anchorNode ?? null)?.closest('[data-hapi-message-role="assistant"]')
            const end = element(selection?.focusNode ?? null)?.closest('[data-hapi-message-role="assistant"]')
            setText(selection && !selection.isCollapsed && start && start === end && scope.current?.contains(start)
                ? selection.toString().trim() : '')
        }
        document.addEventListener('selectionchange', update)
        return () => document.removeEventListener('selectionchange', update)
    }, [scope])
    if (!text) return null
    return <button type="button"
        className="absolute bottom-3 left-3 z-20 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm shadow-md"
        onPointerDown={event => event.preventDefault()}
        onClick={() => {
            const quote = text.split(/\r?\n/).map(line => `> ${line}`).join('\n')
            api.composer().setText(`${draft.trimEnd()}${draft.trim() ? '\n\n' : ''}${quote}\n\n`)
            window.getSelection()?.removeAllRanges()
            setText('')
        }}>
        {t('message.quoteSelection')}
    </button>
}
