import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAui, useAuiState } from '@assistant-ui/react'
import { useTranslation } from '@/lib/use-translation'
import { useOptionalHappyChatContext } from './context'
import { appendBlockquote, appendResponseAnnotation, responseAnnotationFromRange, type ResponseAnnotation } from '@/lib/responseAnnotations'

type QuoteSelection = { annotation: ResponseAnnotation; left: number; top: number }

export function SelectedTextQuote({ scope }: { scope: RefObject<HTMLElement | null> }) {
    const api = useAui()
    const draft = useAuiState(state => state.composer.text)
    const ctx = useOptionalHappyChatContext()
    const { t } = useTranslation()
    const [selected, setSelected] = useState<QuoteSelection | null>(null)
    useEffect(() => {
        const update = () => {
            const selection = window.getSelection()
            const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement
            const start = element(selection?.anchorNode ?? null)?.closest('[data-hapi-message-role="assistant"]')
            const end = element(selection?.focusNode ?? null)?.closest('[data-hapi-message-role="assistant"]')
            if (!selection || selection.isCollapsed || !start || start !== end || !scope.current?.contains(start)
                || selection.rangeCount !== 1) {
                setSelected(null)
                return
            }
            const text = selection.toString().trim()
            if (!text) { setSelected(null); return }
            const range = selection.getRangeAt(0)
            const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
            const rect = rects.at(-1) ?? (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : start.getBoundingClientRect())
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - 150))
            const top = rect.top >= 40 ? rect.top - 34 : Math.min(window.innerHeight - 36, rect.bottom + 6)
            setSelected({ annotation: responseAnnotationFromRange(range, text), left, top })
        }
        document.addEventListener('selectionchange', update)
        document.addEventListener('scroll', update, true)
        window.addEventListener('resize', update)
        return () => {
            document.removeEventListener('selectionchange', update)
            document.removeEventListener('scroll', update, true)
            window.removeEventListener('resize', update)
        }
    }, [scope])
    if (!selected || ctx?.disabled) return null
    return createPortal(<button type="button"
        className="fixed z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs shadow-md"
        style={{ left: selected.left, top: selected.top }}
        onPointerDown={event => event.preventDefault()}
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
            const codex = ctx?.metadata?.flavor === 'codex' || Boolean(ctx?.metadata?.nativeCodex)
            api.composer().setText(codex
                ? appendResponseAnnotation(draft, selected.annotation)
                : appendBlockquote(draft, selected.annotation.text))
            window.getSelection()?.removeAllRanges()
            setSelected(null)
        }}>
        {t('message.quoteSelection')}
    </button>, document.body)
}
