import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { getToolGroupEntries, getToolGroupEntryAnchor, isActiveNativeCodexReasoning, type ToolGroupBlock } from '@/chat/toolGroups'
import type { ChatToolCall, ToolCallBlock } from '@/chat/types'
import { getCodexCommandActions, type CodexCommandAction } from '@/chat/codexCommandPresentation'
import type { SessionMetadataSummary } from '@/types/api'
import { useHappyChatContext, useToolGroupExpansionState } from '@/components/AssistantChat/context'
import { EventMessage } from '@/components/AssistantChat/messages/EventMessage'
import { NativeReasoning, NativeReasoningPreview } from '@/components/AssistantChat/messages/NativeReasoning'
import { CompactCodexAgentToolRow, getToolTimingDetails, ToolDetailDialogContent, ToolStatusIcon, ToolTimingSummary, toolStatusColorClass } from '@/components/ToolCard/ToolCard'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { formatGroupedHeaderSummary, formatGroupedHeaderTitle, safeGroupedLabelValue } from '@/components/ToolCard/groupedPresentation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DisclosureChevron, DisclosureContent } from '@/components/ui/disclosure'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { formatDuration, formatMessageTimestamp, formatMessageTimestampTitle } from '@/chat/presentation'
import { getMinimalToolPreview } from './toolPreview'
import { getCompactCodexAgentTool } from './codexAgents'

const TIMING_INTERVAL_MS = 1000
const GroupNowContext = createContext(0)

export function getToolGroupTiming(tools: ToolCallBlock[], now: number): {
    startedAt: number | null
    completedAt: number | null
    durationMs: number | null
    running: boolean
} {
    const startedValues = tools
        .filter((tool) => tool.tool.state !== 'pending')
        .map((tool) => tool.tool.startedAt ?? tool.tool.createdAt)
        .filter((value): value is number => Number.isFinite(value))
    const startedAt = startedValues.length > 0 ? Math.min(...startedValues) : null
    const running = tools.some((tool) => tool.tool.state === 'running')
    const allFinished = tools.length > 0 && tools.every((tool) => tool.tool.state === 'completed' || tool.tool.state === 'error')
    const completedValues = allFinished
        ? tools.map((tool) => tool.tool.completedAt).filter((value): value is number => value != null && Number.isFinite(value))
        : []
    const completedAt = allFinished && completedValues.length === tools.length ? Math.max(...completedValues) : null
    const durationEnd = running ? now : completedAt
    const durationMs = startedAt != null && durationEnd != null && durationEnd >= startedAt
        ? durationEnd - startedAt
        : null

    return { startedAt, completedAt, durationMs, running }
}

function ToolGroupClock({ running, children }: { running: boolean; children: ReactNode }) {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        if (!running) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), TIMING_INTERVAL_MS)
        return () => clearInterval(id)
    }, [running])

    // Clock ticks update the subscribed timing labels, not the expanded rows.
    return <GroupNowContext.Provider value={now}>{children}</GroupNowContext.Provider>
}

function GroupTimingSummary({ tools }: { tools: ToolCallBlock[] }) {
    const now = useContext(GroupNowContext)
    return <ToolTimingSummary {...getToolGroupTiming(tools, now)} typography="group" />
}

function GroupRowDuration({ tool, now = 0 }: { tool: ChatToolCall; now?: number }) {
    const { durationMs } = getToolTimingDetails(tool, now)
    return durationMs == null ? null : <span className="font-mono text-xs text-[var(--app-hint)]">{formatDuration(durationMs)}</span>
}

function LiveGroupRowDuration({ tool }: { tool: ChatToolCall }) {
    const now = useContext(GroupNowContext)
    return <GroupRowDuration tool={tool} now={now} />
}

function SummaryBadge(props: { className: string; text: string; title?: string }) {
    return (
        <span title={props.title} className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', props.className)}>
            {props.text}
        </span>
    )
}

function RowStatusBadge(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    if (props.block.tool.state === 'error') {
        return <SummaryBadge className="bg-red-500/10 text-red-600" text={t('toolGroup.rowStatus.error')} />
    }
    if (props.block.tool.state === 'running') {
        return <SummaryBadge className="bg-sky-500/10 text-sky-600" text={t('toolGroup.rowStatus.running')} />
    }
    if (props.block.tool.state === 'pending') {
        return <SummaryBadge className="bg-amber-500/10 text-amber-700" text={t('toolGroup.rowStatus.pending')} />
    }
    return null
}

function RowLabel(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null; minimal?: boolean }) {
    const { t } = useTranslation()
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.nativeTitle ?? props.block.tool.description,
        metadata: props.metadata
    }, t), [props.block, props.metadata, t])

    if (props.minimal) {
        const preview = getMinimalToolPreview(props.block.tool, presentation)
        return <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-xs text-[var(--app-fg)]" title={preview}>{preview}</span>
    }

    return (
        <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                    {presentation.icon}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate whitespace-nowrap text-sm font-medium text-[var(--app-fg)]">
                        {presentation.title}
                    </div>
                    {presentation.subtitle ? (
                        <div className="truncate whitespace-nowrap font-mono text-xs text-[var(--app-tool-card-subtitle)]">
                            {presentation.subtitle}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

function basename(value: string): string {
    return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? value
}

function codexActionLabel(
    action: CodexCommandAction,
    t: (key: string, params?: Record<string, string | number>) => string
): { title: string; detail: string | null } {
    if (action.type === 'read') {
        const detail = safeGroupedLabelValue(action.name) ?? safeGroupedLabelValue(action.path)
        return { title: t('toolGroup.codex.read'), detail: detail ? basename(detail) : null }
    }
    if (action.type === 'listFiles') {
        return { title: t('toolGroup.codex.list'), detail: safeGroupedLabelValue(action.path) }
    }
    if (action.type === 'search') {
        const query = safeGroupedLabelValue(action.query)
        const path = safeGroupedLabelValue(action.path)
        return {
            title: t('toolGroup.codex.search'),
            detail: query && path
                ? t('toolGroup.codex.searchIn', { query, path })
                : query ?? path
        }
    }
    return { title: t('toolGroup.friendly.genericCommand'), detail: null }
}

function CodexExplorationRows(props: {
    tool: ToolCallBlock
    onSelect: (toolId: string) => void
}) {
    const { t } = useTranslation()
    const { tool } = props
    return getCodexCommandActions(tool).map((action, index) => {
        const label = codexActionLabel(action, t)
        return (
            <button
                key={`${tool.id}:${index}`}
                data-hapi-scroll-anchor={`tool:${tool.id}`}
                type="button"
                className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1 text-left hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                onClick={() => props.onSelect(tool.id)}
            >
                <span className="mt-1 text-xs text-[var(--app-hint)]">└</span>
                <span className="shrink-0 text-sm font-medium text-[var(--app-tool-card-accent)]">
                    {label.title}
                </span>
                {label.detail ? (
                    <span className="min-w-0 truncate text-sm text-[var(--app-fg)]">
                        {label.detail}
                    </span>
                ) : null}
            </button>
        )
    })
}

export function ToolGroupCard(props: {
    block: ToolGroupBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const minimal = ctx.terminalToolDisplayMode === 'minimal'
    const panelId = useId()
    const expansion = useToolGroupExpansionState()
    const [, setExpansionRevision] = useState(0)
    const entries = getToolGroupEntries(props.block)
    const memberIds = entries.map(entry => entry.id)
    const open = expansion.get(memberIds, props.block.defaultOpen)
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
    const runningTool = props.block.tools.some(tool => tool.tool.state === 'running')

    useEffect(() => {
        setSelectedToolId(null)
    }, [props.block.id, props.block.defaultOpen, expansion])

    const selectedTool = useMemo(
        () => props.block.tools.find((tool) => tool.id === selectedToolId) ?? null,
        [props.block.tools, selectedToolId]
    )
    const selectedPresentation = useMemo(() => {
        if (!selectedTool) return null
        return getToolPresentation({
            toolName: selectedTool.tool.name,
            input: selectedTool.tool.input,
            result: selectedTool.tool.result,
            childrenCount: selectedTool.children.length,
            description: selectedTool.tool.nativeTitle ?? selectedTool.tool.description,
            metadata: props.metadata
        }, t)
    }, [selectedTool, props.metadata, t])

    const toolCount = props.block.tools.length
    const activityCount = entries.filter(entry => entry.kind === 'agent-event').length
    const latestReasoning = entries.findLast(entry => entry.kind === 'agent-reasoning')
    const running = runningTool || (latestReasoning !== undefined && isActiveNativeCodexReasoning(latestReasoning))
    const reasoningPreview = running ? latestReasoning?.text : undefined
    const primaryTitle = toolCount > 0 ? formatGroupedHeaderTitle(props.block, t)
        : t(latestReasoning ? 'toolGroup.workProcess' : 'toolGroup.agentActivity')
    const minimalState = props.block.summary.errorCount > 0 ? 'error'
        : props.block.summary.pendingCount > 0 ? 'pending'
            : running ? 'running' : 'completed'
    const summaryParts = formatGroupedHeaderSummary(props.block, t)
    const toolCountLabel = toolCount > 0 ? t('toolGroup.toolCount', { n: toolCount }) : null
    const activityCountLabel = activityCount > 0
        ? t(activityCount === 1 ? 'toolGroup.agentUpdate' : 'toolGroup.agentUpdates', { n: activityCount })
        : null
    const exploration = props.block.presentationMode === 'codex-exploration'
    const toolSummaryParts = minimal || summaryParts.length === 0
        ? toolCountLabel ? [toolCountLabel] : []
        : summaryParts
    const headerSummaryParts = [
        ...(!minimal && exploration ? [] : toolSummaryParts),
        ...(activityCountLabel ? [activityCountLabel] : []),
    ]
    const fileCount = props.block.summary.fileTargets.length
    const headerSummary = headerSummaryParts.join(' · ')
    const headerState = minimal && (toolCount > 0 || running) ? minimalState : running ? 'running' : null
    const hasStatusBadges = props.block.summary.runningCount > 0 || props.block.summary.pendingCount > 0
        || props.block.summary.errorCount > 0 || fileCount > 0

    const card = (
        <Card data-hapi-scroll-anchors={JSON.stringify(entries.map(getToolGroupEntryAnchor))} className="overflow-hidden rounded-[20px] bg-[var(--app-tool-group-bg)] shadow-none">
            <CardHeader className={cn('space-y-0', minimal ? 'px-3 py-2' : 'p-3', !minimal && summaryParts.length > 0 ? 'pb-2' : null)}>
                <button
                    type="button"
                    onClick={() => {
                        expansion.set(memberIds, props.block.defaultOpen, !open)
                        setExpansionRevision(value => value + 1)
                    }}
                    className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-expanded={open}
                    aria-controls={panelId}
                >
                    <div className={cn('flex min-w-0 justify-between gap-3', minimal ? 'items-center' : 'items-start')}>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex min-w-0 items-center gap-2">
                                {headerState && (
                                    <span
                                        className={cn('shrink-0', toolStatusColorClass(headerState))}
                                        aria-label={headerState === 'running' ? t('toolGroup.rowStatus.running') : undefined}
                                    >
                                        <ToolStatusIcon state={headerState} />
                                    </span>
                                )}
                                <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                                    <DisclosureChevron open={open} />
                                </div>
                                <CardTitle className={cn('min-w-0 truncate whitespace-nowrap leading-tight',
                                    reasoningPreview ? 'text-xs font-normal text-[var(--app-hint)]' : 'text-[var(--app-fg)]',
                                    !reasoningPreview && (minimal ? 'text-xs font-normal' : 'text-sm font-medium'))}
                                    title={!reasoningPreview ? primaryTitle : undefined}>
                                    {reasoningPreview ? <NativeReasoningPreview text={reasoningPreview} /> : primaryTitle}
                                </CardTitle>
                            </div>
                            {!minimal ? <GroupTimingSummary tools={props.block.tools} /> : null}
                        </div>
                        {headerSummary || (!minimal && hasStatusBadges) ? (
                            <div className="ml-auto flex min-w-0 max-w-[45%] shrink-0 items-center text-xs text-[var(--app-hint)]">
                                {minimal ? (
                                    <span className="min-w-0 truncate" title={headerSummary}>{headerSummary}</span>
                                ) : (
                                    <span className="flex min-w-0 flex-wrap justify-end gap-1">
                                        {headerSummaryParts.map(part => (
                                            <SummaryBadge
                                                key={part}
                                                className="max-w-full whitespace-nowrap bg-[var(--app-subtle-bg)] text-xs font-normal text-[var(--app-hint)]"
                                                text={part}
                                            />
                                        ))}
                                        {props.block.summary.runningCount > 0 ? <SummaryBadge
                                            className="bg-sky-500/10 text-sky-600"
                                            text={t('toolGroup.badge.running', { n: props.block.summary.runningCount })}
                                        /> : null}
                                        {props.block.summary.pendingCount > 0 ? <SummaryBadge
                                            className="bg-amber-500/10 text-amber-700"
                                            text={t('toolGroup.badge.pending', { n: props.block.summary.pendingCount })}
                                        /> : null}
                                        {props.block.summary.errorCount > 0 ? <SummaryBadge
                                            className="bg-red-500/10 text-red-600"
                                            text={t('toolGroup.badge.error', { n: props.block.summary.errorCount })}
                                        /> : null}
                                        {fileCount > 0 ? <SummaryBadge
                                            className="bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                                            text={t('toolGroup.badge.fileTargets', { n: fileCount })}
                                        /> : null}
                                    </span>
                                )}
                            </div>
                        ) : null}
                    </div>
                </button>
            </CardHeader>

            <DisclosureContent open={open} id={panelId}>
                {() => (
                    <CardContent className="px-3 pb-3 pt-1">
                        <div className="flex flex-col gap-2">
                            {entries.map((entry) => {
                                if (entry.kind === 'agent-reasoning') {
                                    return <NativeReasoning key={entry.id} block={entry} className="px-1" />
                                }
                                if (entry.kind === 'agent-event') {
                                    const createdAt = new Date(entry.createdAt)
                                    return (
                                        <div key={entry.id} data-hapi-scroll-anchor={getToolGroupEntryAnchor(entry)}>
                                            <EventMessage event={entry.event} timestamp={(
                                                <time dateTime={createdAt.toISOString()} title={formatMessageTimestampTitle(createdAt)} className="tabular-nums text-[10px]">
                                                    {formatMessageTimestamp(createdAt)}
                                                </time>
                                            )} />
                                        </div>
                                    )
                                }
                                const tool = entry
                                if (exploration && !minimal) {
                                    return <CodexExplorationRows key={tool.id} tool={tool} onSelect={setSelectedToolId} />
                                }
                                const compactAgent = getCompactCodexAgentTool(tool)
                                if (compactAgent) {
                                    return <CompactCodexAgentToolRow key={tool.id} block={tool} metadata={props.metadata} detail={compactAgent.detail} />
                                }
                                return (
                                    <button
                                        key={tool.id}
                                        data-hapi-scroll-anchor={getToolGroupEntryAnchor(tool)}
                                        type="button"
                                        className="flex min-w-0 items-center gap-3 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                        onClick={() => setSelectedToolId(tool.id)}
                                    >
                                        <span className={cn('shrink-0', toolStatusColorClass(tool.tool.state))}>
                                            <ToolStatusIcon state={tool.tool.state} />
                                        </span>
                                        <RowLabel block={tool} metadata={props.metadata} minimal={minimal} />
                                        {!minimal ? <div className="flex shrink-0 items-center gap-2">
                                            {tool.tool.state === 'running'
                                                ? <LiveGroupRowDuration tool={tool.tool} />
                                                : <GroupRowDuration tool={tool.tool} />}
                                            <RowStatusBadge block={tool} />
                                        </div> : null}
                                    </button>
                                )
                            })}
                        </div>
                    </CardContent>
                )}
            </DisclosureContent>

            <Dialog open={selectedTool !== null} onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    setSelectedToolId(null)
                }
            }}>
                <DialogContent className="max-w-2xl" closeButtonClassName="top-2" aria-describedby={undefined}>
                    {selectedTool && selectedPresentation ? (
                        <>
                            <DialogHeader className="text-left">
                                <DialogTitle>{selectedPresentation.title}</DialogTitle>
                            </DialogHeader>
                            <ToolDetailDialogContent block={selectedTool} metadata={props.metadata} />
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </Card>
    )
    return <ToolGroupClock running={runningTool}>{card}</ToolGroupClock>
}
