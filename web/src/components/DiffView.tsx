import { diffLines, parsePatch } from 'diff'
import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import { CodeBlock } from '@/components/CodeBlock'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { useCodeWrap } from '@/hooks/useCodeWrap'
import { WrapIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

type DiffSection = {
    oldStart: number
    newStart: number
    lines: string[]
}

type DiffContent = {
    sections: DiffSection[]
    additions: number
    deletions: number
    lineNumberWidth: number
    summary: string
}

function splitDiffLines(text: string): string[] {
    if (text.length === 0) return []
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
    }
    return lines
}

function buildDiffContent(sections: DiffSection[], maxLineNumber: number, summary?: string): DiffContent {
    let additions = 0
    let deletions = 0
    for (const section of sections) {
        for (const line of section.lines) {
            if (line[0] === '+') additions += 1
            if (line[0] === '-') deletions += 1
        }
    }
    return {
        sections,
        additions,
        deletions,
        lineNumberWidth: Math.max(String(maxLineNumber).length, 2),
        summary: summary ?? `+${additions} / -${deletions}`,
    }
}

function diffFromText(oldString: string, newString: string): DiffContent {
    const oldLines = splitDiffLines(oldString).length
    const newLines = splitDiffLines(newString).length
    const lines = diffLines(oldString, newString).flatMap((part) => {
        const prefix = part.added ? '+' : part.removed ? '-' : ' '
        return splitDiffLines(part.value).map((line) => prefix + line)
    })
    return buildDiffContent(
        [{ oldStart: 1, newStart: 1, lines }],
        Math.max(oldLines, newLines),
        `${oldLines.toLocaleString()} → ${newLines.toLocaleString()} lines`,
    )
}

function diffFromPatch(patch: string): DiffContent | null {
    try {
        const [file, nextFile] = parsePatch(patch)
        if (!file?.hunks.length || nextFile) return null
        const sections = file.hunks
        const maxLineNumber = sections.reduce((max, hunk) => Math.max(
            max, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1,
        ), 0)
        return buildDiffContent(sections, maxLineNumber)
    } catch {
        return null
    }
}

function DiffStatBadge(props: { tone: 'added' | 'removed'; value: number }) {
    const className = props.tone === 'added'
        ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]'
        : 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]'

    return (
        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium', className)}>
            {props.tone === 'added' ? '+' : '-'}{props.value}
        </span>
    )
}

function DiffWrapToggle() {
    const { t } = useTranslation()
    const { codeWrap, setCodeWrap } = useCodeWrap()

    return (
        <button
            type="button"
            data-hapi-code-wrap-toggle="true"
            data-hapi-wrap-enable-label={t('code.wrap.enable')}
            data-hapi-wrap-disable-label={t('code.wrap.disable')}
            data-hapi-share-export-exclude="true"
            onClick={(event) => {
                event.stopPropagation()
                setCodeWrap(!codeWrap)
            }}
            className={cn(
                'rounded-md p-1 transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)]',
                codeWrap ? 'text-[var(--app-fg)]' : 'text-[var(--app-code-header-fg)]'
            )}
            title={t(codeWrap ? 'code.wrap.disable' : 'code.wrap.enable')}
            aria-pressed={codeWrap}
        >
            <WrapIcon className="h-3.5 w-3.5" />
        </button>
    )
}

type DiffViewProps = {
    filePath?: string
    variant?: 'preview' | 'inline'
    size?: 'compact' | 'comfortable'
    scrollY?: boolean
    maxHeight?: number
} & (
    | { oldString: string; newString: string; unifiedDiff?: never }
    | { unifiedDiff: string; oldString?: never; newString?: never }
)

export function DiffView(props: DiffViewProps) {
    const { t } = useTranslation()
    const variant = props.variant ?? 'preview'
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()

    const { oldString, newString, unifiedDiff } = props
    const diff = useMemo(() => unifiedDiff === undefined
        ? diffFromText(oldString, newString)
        : diffFromPatch(unifiedDiff), [oldString, newString, unifiedDiff])

    if (!diff) {
        return <CodeBlock code={unifiedDiff ?? ''} language="diff" title={props.filePath} size={props.size} scrollY={props.scrollY} maxHeight={props.maxHeight} />
    }

    const title = props.filePath ? props.filePath : t('diff.title')
    const subtitle = props.filePath ? diff.summary : `${t('diff.title')} • ${diff.summary}`

    const diffInline = (
        <DiffInlineView
            diff={diff}
            filePath={props.filePath}
            showHeader
            size={props.size}
            scrollY={props.scrollY}
            maxHeight={props.maxHeight}
        />
    )

    if (variant === 'inline') {
        return diffInline
    }

    return (
        <Dialog>
            <div className="overflow-hidden rounded-2xl bg-[var(--app-code-bg)] transition-colors">
                <div className="flex items-center gap-3 bg-[var(--app-code-header-bg)] px-3 py-2">
                    <DialogTrigger asChild>
                        <button
                            type="button"
                            aria-label={props.filePath ? `Open diff for ${props.filePath}` : 'Open diff preview'}
                            className={cn(
                                'flex min-w-0 flex-1 items-center justify-between gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                                suppressFocusRing && 'focus-visible:ring-0'
                            )}
                            onPointerDown={onTriggerPointerDown}
                            onKeyDown={onTriggerKeyDown}
                            onBlur={onTriggerBlur}
                        >
                            <div className="min-w-0">
                                <div className="truncate font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--app-code-header-fg)]">
                                    {props.filePath ?? t('diff.title')}
                                </div>
                                <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                                    {diff.summary}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <DiffStatBadge tone="added" value={diff.additions} />
                                <DiffStatBadge tone="removed" value={diff.deletions} />
                                <span className="text-xs font-medium text-[var(--app-link)]">{t('diff.view')}</span>
                            </div>
                        </button>
                    </DialogTrigger>
                    <DiffWrapToggle />
                </div>
                <div className="max-h-40 overflow-hidden">
                    <DiffInlineView
                        diff={diff}
                        showHeader={false}
                        size={props.size}
                    />
                </div>
            </div>
            <DialogContent className="max-w-5xl">
                <DialogHeader>
                    <DialogTitle className="break-all">{title}</DialogTitle>
                    <DialogDescription className="break-all font-mono">
                        {subtitle}
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-3 max-h-[75vh] overflow-auto">
                    {diffInline}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function DiffInlineView(props: {
    diff: DiffContent
    filePath?: string
    showHeader: boolean
    size?: 'compact' | 'comfortable'
    scrollY?: boolean
    maxHeight?: number
}) {
    const { diff } = props
    const { codeWrap } = useCodeWrap()
    const isComfortable = props.size === 'comfortable'
    const { lineNumberWidth } = diff
    // Same trap as CodeBlock's Phase 1 spike: a `max-content` third track
    // lets the row claim full content width before `whitespace-pre-wrap`
    // ever gets a chance to wrap, so wrap-on must also switch the track to
    // `minmax(0, 1fr)`. Both size variants follow the global wrap setting.
    const codeColumnTrack = codeWrap ? 'minmax(0, 1fr)' : 'max-content'
    const rowStyle = {
        gridTemplateColumns: `${lineNumberWidth}ch ${lineNumberWidth}ch ${codeColumnTrack}`
    } satisfies CSSProperties

    const body = (
        <div
            className={cn(
                codeWrap ? '' : 'overflow-x-auto',
                props.scrollY ? 'overflow-y-auto' : 'overflow-y-hidden'
            )}
            style={props.scrollY ? { maxHeight: props.maxHeight ?? 420 } : undefined}
        >
            <div className={cn(
                'hapi-diff-code',
                isComfortable ? 'text-sm leading-6' : 'text-xs',
                codeWrap ? 'w-full' : 'w-max min-w-full'
            )}>
                {diff.sections.map((section, i) => {
                    let oldLineNumber = section.oldStart
                    let newLineNumber = section.newStart

                    return (
                        <div key={i}>
                            {i > 0 && (
                                <div aria-hidden="true" className="bg-[var(--app-code-header-bg)] px-3 text-xs text-[var(--app-code-header-fg)]">
                                    …
                                </div>
                            )}
                            {section.lines.map((line, j) => {
                                const prefix = line[0]
                                const isNote = prefix === '\\'
                                const leftNumber = prefix === '+' || isNote ? '' : String(oldLineNumber++)
                                const rightNumber = prefix === '-' || isNote ? '' : String(newLineNumber++)
                                const rowClass = cn(
                                    'grid min-w-full gap-3',
                                    isComfortable ? 'px-4' : 'px-3',
                                    isComfortable ? 'py-0' : 'py-1.5',
                                    prefix === '+' && 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]',
                                    prefix === '-' && 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]',
                                    isNote && 'text-[var(--app-hint)]'
                                )

                                return (
                                    <div key={j} className={rowClass} style={rowStyle}>
                                        <div className={cn('text-left text-[var(--app-hint)]/80', isComfortable ? 'text-xs leading-6' : 'text-[10px]')}>{leftNumber}</div>
                                        <div className={cn('text-left text-[var(--app-hint)]/80', isComfortable ? 'text-xs leading-6' : 'text-[10px]')}>{rightNumber}</div>
                                        <div className={cn(
                                            codeWrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre'
                                        )}>
                                            <span className="mr-2 inline-block w-3 text-[var(--app-hint)]/90">{prefix}</span>
                                            <span>{line.slice(1)}</span>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )
                })}
            </div>
        </div>
    )

    return (
        <div className={cn('overflow-hidden bg-[var(--app-code-bg)]', props.showHeader ? 'rounded-2xl' : 'rounded-none')}>
            {props.showHeader ? (
                <div className="flex items-center justify-between gap-3 bg-[var(--app-code-header-bg)] px-3 py-2">
                    <div className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--app-code-header-fg)]">{props.filePath ?? 'Diff'}</div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <DiffStatBadge tone="added" value={diff.additions} />
                        <DiffStatBadge tone="removed" value={diff.deletions} />
                        <DiffWrapToggle />
                    </div>
                </div>
            ) : null}
            {body}
        </div>
    )
}
