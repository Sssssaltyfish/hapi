import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAui, useAuiState } from '@assistant-ui/react'
import { useTranslation } from '@/lib/use-translation'
import { useOptionalHappyChatContext } from './context'
import { responseAnnotationFromRange, type ResponseAnnotation } from '@/lib/responseAnnotations'
import { appendSelectionQuote, resolveQuoteInputCapability } from '@/lib/quoteInputCapabilities'
import { usePlatform } from '@/hooks/usePlatform'

type QuoteSelection = { annotation: ResponseAnnotation; position?: { left: number; top: number } }

export function SelectedTextQuote({ scope }: { scope: RefObject<HTMLElement | null> }) {
    const api = useAui()
    const draft = useAuiState(state => state.composer.text)
    const ctx = useOptionalHappyChatContext()
    const { isTouch } = usePlatform()
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
            const annotation = responseAnnotationFromRange(range, text)
            // Native touch selection menus have no exposed bounds. Keep our
            // action in the chat/composer boundary instead of guessing where
            // that menu appears or interfering with its default behavior.
            if (isTouch) {
                setSelected({ annotation })
                return
            }
            const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
            const rect = rects.at(-1) ?? (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : start.getBoundingClientRect())
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - 150))
            const top = rect.top >= 40 ? rect.top - 34 : Math.min(window.innerHeight - 36, rect.bottom + 6)
            setSelected({ annotation, position: { left, top } })
        }
        document.addEventListener('selectionchange', update)
        document.addEventListener('scroll', update, true)
        window.addEventListener('resize', update)
        return () => {
            document.removeEventListener('selectionchange', update)
            document.removeEventListener('scroll', update, true)
            window.removeEventListener('resize', update)
        }
    }, [scope, isTouch])
    if (!selected || ctx?.disabled) return null
    const button = <button type="button"
        className={`${isTouch ? '' : 'fixed z-50 shadow-md '}rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs`}
        style={selected.position}
        onPointerDown={event => event.preventDefault()}
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
            api.composer().setText(appendSelectionQuote(draft, selected.annotation, resolveQuoteInputCapability(ctx?.metadata)))
            window.getSelection()?.removeAllRanges()
            setSelected(null)
        }}>
        {t('message.quoteSelection')}
    </button>
    // This component is mounted immediately after the transcript viewport.
    // The touch action stays outside the selectable content and reserves its
    // own compact row, avoiding a second popup beside the native selection UI.
    return isTouch
        ? <div role="toolbar" aria-label={t('message.quoteSelection')}
            data-hapi-selection-actions="true" className="flex shrink-0 select-none items-center px-3 py-1">{button}</div>
        : createPortal(button, document.body)
}
