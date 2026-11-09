import { memo, useId, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { AgentReasoningBlock } from '@/chat/types'
import { getToolGroupEntryAnchor, isActiveNativeCodexReasoning } from '@/chat/toolGroups'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ReasoningScroll } from '@/components/assistant-ui/reasoning'
import { useNativeReasoningExpansionState } from '@/components/AssistantChat/context'
import { DisclosureChevron, DisclosureContent } from '@/components/ui/disclosure'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

const INLINE_PREVIEW_ELEMENTS = ['strong', 'em', 'code']

export const NativeReasoningPreview = memo(function NativeReasoningPreview({ text }: { text: string }) {
    return (
        <ReactMarkdown allowedElements={INLINE_PREVIEW_ELEMENTS} unwrapDisallowed>
            {text.trim().split(/\r\n?|\n/, 1)[0]}
        </ReactMarkdown>
    )
})

export const NativeReasoning = memo(function NativeReasoning({ block, className }: { block: AgentReasoningBlock; className?: string }) {
    const { t } = useTranslation()
    const { reasoningCollapsed } = useReasoningCollapse()
    const expansion = useNativeReasoningExpansionState()
    const panelId = useId()
    const widthRef = useRef<HTMLDivElement>(null)
    const previewRef = useRef<HTMLSpanElement>(null)
    const [fits, setFits] = useState(true)
    const [, setExpansionRevision] = useState(0)
    const text = block.text.trim()
    const hasBlockStructure = /[\r\n]|^(?:[-*+]|\d+[.)])\s|^(?:```|~~~)/.test(text)
    const inline = !hasBlockStructure && fits
    const active = isActiveNativeCodexReasoning(block)
    const saved = expansion.get(block.id)
    const followsPreference = active && !saved?.manual
    const open = followsPreference ? !reasoningCollapsed : saved?.open ?? false
    const textToMeasure = typeof ResizeObserver === 'undefined' ? text : null

    useLayoutEffect(() => {
        const frame = widthRef.current
        const preview = previewRef.current
        if (!frame || !preview) return
        if (typeof ResizeObserver === 'undefined') {
            const available = frame.getBoundingClientRect().width
            if (available > 0) setFits(preview.getBoundingClientRect().width <= available)
            return
        }

        let frameWidth: number | undefined
        let previewWidth: number | undefined
        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === frame) frameWidth = entry.contentRect.width
                if (entry.target === preview) previewWidth = entry.contentRect.width
            }
            if (frameWidth !== undefined && frameWidth > 0 && previewWidth !== undefined) {
                setFits(previewWidth <= frameWidth)
            }
        })
        observer.observe(frame)
        observer.observe(preview)
        return () => observer.disconnect()
    }, [textToMeasure, hasBlockStructure])

    useLayoutEffect(() => {
        // Keep an opened card in place when the active summary moves on.
        if (!inline && followsPreference && open !== (saved?.open ?? false)) {
            expansion.set(block.id, { open, manual: false })
        }
    }, [block.id, expansion, followsPreference, inline, open, saved])

    return (
        <div data-hapi-scroll-anchor={getToolGroupEntryAnchor(block)} data-hapi-share-exclude="true" className={cn('min-w-0', className)}>
            <div ref={widthRef} className="relative min-w-0 overflow-hidden">
                {!hasBlockStructure && (
                    <span
                        ref={previewRef}
                        data-hapi-native-reasoning={inline ? 'inline' : undefined}
                        aria-hidden={inline ? undefined : true}
                        className={cn('aui-reasoning-content block w-max whitespace-nowrap',
                            !inline && 'pointer-events-none invisible absolute left-0 top-0 select-none')}
                    >
                        <NativeReasoningPreview text={text} />
                    </span>
                )}
                {!inline && (
                    <div data-hapi-native-reasoning="disclosure" className="aui-reasoning-group overflow-hidden rounded-2xl bg-[var(--app-reasoning-bg)]">
                        <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={panelId}
                            onClick={() => {
                                expansion.set(block.id, { open: !open, manual: true })
                                setExpansionRevision(value => value + 1)
                            }}
                            className="flex w-full cursor-pointer select-none items-center gap-1.5 px-3.5 py-2.5 text-left text-xs font-medium text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                        >
                            <DisclosureChevron open={open} className="h-3 w-3" />
                            <span>{t('native.reasoning')}</span>
                            {active && <span aria-hidden="true" className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />}
                        </button>
                        <DisclosureContent open={open} id={panelId}>
                            {() => (
                                <ReasoningScroll isOpen={open} isStreaming={active} className="px-3.5 pb-3">
                                    <MarkdownRenderer content={block.text} className="aui-reasoning-content" preserveSingleLineBreaks defer />
                                </ReasoningScroll>
                            )}
                        </DisclosureContent>
                    </div>
                )}
            </div>
        </div>
    )
})
