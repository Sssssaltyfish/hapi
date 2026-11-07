import { isAgentActivityEvent, type AgentEventBlock, type AgentReasoningBlock, type ChatBlock, type RoundSummary, type ToolCallBlock } from '@/chat/types'
import { isCodexExplorationTool } from '@/chat/codexCommandPresentation'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { getInputStringAny } from '@/lib/toolInputUtils'

export type ToolGroupActionKind = 'read' | 'search' | 'command' | 'mutation' | 'web' | 'other'

export type ToolGroupSummary = {
    totalTools: number
    countsByKind: Record<ToolGroupActionKind, number>
    fileTargets: string[]
    commandTargets: string[]
    searchTargets: string[]
    urlTargets: string[]
    otherTargets: string[]
    errorCount: number
    runningCount: number
    pendingCount: number
}

type ToolGroupStep = AgentEventBlock | AgentReasoningBlock
export type ToolGroupEntry = ToolCallBlock | ToolGroupStep

export type ToolGroupBlock = {
    kind: 'tool-group'
    id: string
    createdAt: number
    invokedAt?: number | null
    firstToolId?: string
    lastToolId?: string
    tools: ToolCallBlock[]
    steps?: { beforeToolIndex: number; block: ToolGroupStep }[]
    defaultOpen: boolean
    historyState: 'complete' | 'needs-older-history'
    needsOlderHistory: boolean
    activityTitle?: string | null
    presentationMode?: 'default' | 'codex-exploration'
    roundSummary?: RoundSummary
    summary: ToolGroupSummary
}

export type VisibleChatBlock = ChatBlock | ToolGroupBlock

export type VisibleChatBlockRole = 'user' | 'assistant' | 'system'

/**
 * The role a block renders under in the thread. `@assistant-ui/react` joins
 * adjacent assistant-role blocks into a single card, so this also determines
 * how many rows a run of blocks actually produces on screen.
 */
export function visibleBlockRole(block: VisibleChatBlock): VisibleChatBlockRole {
    if (block.kind === 'user-text') return 'user'
    if (block.kind === 'agent-event') return 'system'
    if (block.kind === 'cli-output') return block.source === 'user' ? 'user' : 'assistant'
    return 'assistant'
}

type ToolGroupingOptions = {
    hasMoreMessages: boolean
    previousGroups?: ToolGroupBlock[]
    toolGroupsCollapsed?: boolean
}

const PLAN_TOOL_NAMES = new Set([
    'TodoWrite',
    'update_plan',
    'ExitPlanMode',
    'exit_plan_mode',
    'CodexReasoning'
])

const MILESTONE_TOOL_NAMES = new Set([
    'Task',
    'Agent',
    'CodexAgent',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    // agy's transitional task-log chip — keep it standalone (like SendMessage)
    // so it reads as a thin marker instead of being folded into a tool group.
    'AgyTaskLog',
    'Skill',
    'spawn_agent',
    'resume_agent',
    'close_agent',
    'interrupt_agent',
    'list_agents'
])

const INTERACTIVE_TOOL_NAMES = new Set([
    'CodexPermission'
])

function pushUnique(target: string[], value: string | null): void {
    if (!value) return
    if (target.includes(value)) return
    target.push(value)
}

function normalizeCommandInput(input: unknown): string | null {
    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return direct

    if (!input || typeof input !== 'object') return null
    const command = (input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

export function getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    const name = block.tool.name

    if (name === 'Read' || name === 'NotebookRead') return 'read'
    if (name === 'Grep' || name === 'Glob' || name === 'LS') return 'search'
    if (name === 'Bash' || name === 'CodexBash' || name === 'shell_command' || name === 'run_shell_command') return 'command'
    if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit' || name === 'CodexPatch' || name === 'CodexDiff') {
        return 'mutation'
    }
    if (name === 'WebFetch' || name === 'WebSearch') return 'web'
    return 'other'
}

function getPrimaryFileTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['file_path', 'path', 'file', 'filePath', 'notebook_path', 'name'])
}

function getPrimarySearchTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['pattern', 'query'])
}

function getPrimaryUrlTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['url'])
}

function getPrimaryOtherTarget(block: ToolCallBlock): string | null {
    const fileTarget = getPrimaryFileTarget(block)
    if (fileTarget) return fileTarget

    const searchTarget = getPrimarySearchTarget(block)
    if (searchTarget) return searchTarget

    const commandTarget = normalizeCommandInput(block.tool.input)
    if (commandTarget) return commandTarget

    const urlTarget = getPrimaryUrlTarget(block)
    if (urlTarget) return urlTarget

    return block.tool.name
}

function summarizeToolGroup(tools: ToolCallBlock[]): ToolGroupSummary {
    const countsByKind: Record<ToolGroupActionKind, number> = {
        read: 0,
        search: 0,
        command: 0,
        mutation: 0,
        web: 0,
        other: 0
    }
    const fileTargets: string[] = []
    const commandTargets: string[] = []
    const searchTargets: string[] = []
    const urlTargets: string[] = []
    const otherTargets: string[] = []
    let errorCount = 0
    let runningCount = 0
    let pendingCount = 0

    for (const tool of tools) {
        const kind = getToolGroupActionKind(tool)
        countsByKind[kind] += 1

        if (tool.tool.state === 'error') {
            errorCount += 1
        } else if (tool.tool.state === 'running') {
            runningCount += 1
        } else if (tool.tool.state === 'pending') {
            pendingCount += 1
        }

        if (kind === 'read' || kind === 'mutation') {
            pushUnique(fileTargets, getPrimaryFileTarget(tool))
            continue
        }
        if (kind === 'search') {
            pushUnique(searchTargets, getPrimarySearchTarget(tool))
            continue
        }
        if (kind === 'command') {
            pushUnique(commandTargets, normalizeCommandInput(tool.tool.input))
            continue
        }
        if (kind === 'web') {
            pushUnique(urlTargets, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(otherTargets, getPrimaryOtherTarget(tool))
    }

    return {
        totalTools: tools.length,
        countsByKind,
        fileTargets,
        commandTargets,
        searchTargets,
        urlTargets,
        otherTargets,
        errorCount,
        runningCount,
        pendingCount,
    }
}

function isInteractiveToolBlock(block: ToolCallBlock): boolean {
    return INTERACTIVE_TOOL_NAMES.has(block.tool.name)
        || block.tool.permission?.status === 'pending'
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)
}

export function isEligibleForToolGrouping(block: ToolCallBlock): boolean {
    if (isSubagentToolName(block.tool.name)) return false
    if (PLAN_TOOL_NAMES.has(block.tool.name)) return false
    if (MILESTONE_TOOL_NAMES.has(block.tool.name)) return false
    if (isInteractiveToolBlock(block)) return false
    // Command classification selects the group family, not eligibility.
    // Shared Codex reports ordinary agent commands as `unknown` actions.
    if (block.tool.name === 'CodexBash'
        && getInputStringAny(block.tool.input, ['command_source', 'commandSource'])?.toLowerCase() === 'usershell') return false
    return true
}

function blockMetadata(block: ChatBlock): Record<string, unknown> | undefined {
    return block.meta && typeof block.meta === 'object' ? block.meta as Record<string, unknown> : undefined
}

function codexTurnId(block: ChatBlock): string | undefined {
    const turnId = blockMetadata(block)?.codexTurnId
    return typeof turnId === 'string' ? turnId : undefined
}

export function isNativeCodexReasoning(block: AgentReasoningBlock): boolean {
    return blockMetadata(block)?.nativeCodexRecord === true
}

export function isActiveNativeCodexReasoning(block: AgentReasoningBlock): boolean {
    return blockMetadata(block)?.nativeReasoningActive === true
}

function getGroupingEntry(block: ChatBlock): ToolGroupEntry | null {
    if (block.kind === 'tool-call' && isEligibleForToolGrouping(block)) return block
    if (block.kind === 'agent-reasoning' && isNativeCodexReasoning(block)) return block
    if (block.kind === 'agent-event' && isAgentActivityEvent(block.event)
        && blockMetadata(block)?.nativeCodexRecord === true) return block
    return null
}

function getGroupingFamily(block: ToolGroupEntry): 'default' | 'codex-exploration' | undefined {
    if (block.kind !== 'tool-call') return undefined
    return isCodexExplorationTool(block) ? 'codex-exploration' : 'default'
}

export function getToolGroupEntries(group: ToolGroupBlock): readonly ToolGroupEntry[] {
    if (!group.steps?.length) return group.tools
    const entries: ToolGroupEntry[] = []
    let cursor = 0
    for (const step of group.steps) {
        entries.push(...group.tools.slice(cursor, step.beforeToolIndex), step.block)
        cursor = step.beforeToolIndex
    }
    entries.push(...group.tools.slice(cursor))
    return entries
}

export function getToolGroupEntryAnchor(entry: ToolGroupEntry): string {
    return `${entry.kind === 'tool-call' ? 'tool' : entry.kind}:${entry.id}`
}

function createToolGroupId(
    entries: readonly ToolGroupEntry[],
    needsOlderHistory: boolean,
    previousGroups: ToolGroupBlock[]
): string {
    const firstId = entries[0].id
    const lastId = entries[entries.length - 1].id
    const previous = previousGroups.find((group) => {
        const previousEntries = getToolGroupEntries(group)
        return previousEntries[0]?.id === firstId || previousEntries.at(-1)?.id === lastId
    })
    if (previous) {
        return previous.id
    }

    return needsOlderHistory
        ? `tool-group:${lastId}`
        : `tool-group:${firstId}`
}

export function isToolGroupBlock(block: VisibleChatBlock | ChatBlock): block is ToolGroupBlock {
    return block.kind === 'tool-group'
}

export function buildVisibleChatBlocks(
    blocks: ChatBlock[],
    options: ToolGroupingOptions
): VisibleChatBlock[] {
    const visibleBlocks: VisibleChatBlock[] = []
    const previousGroups = options.previousGroups ?? []

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        const entry = getGroupingEntry(block)
        if (!entry) {
            visibleBlocks.push(block)
            continue
        }

        let groupingFamily = getGroupingFamily(entry)
        const turnId = codexTurnId(entry)
        const entries = [entry]
        let cursor = index + 1
        while (cursor < blocks.length) {
            const candidate = getGroupingEntry(blocks[cursor])
            if (!candidate || turnId !== codexTurnId(candidate)
                || (turnId === undefined && (entry.kind !== 'tool-call' || candidate.kind !== 'tool-call'))) {
                break
            }
            const candidateFamily = getGroupingFamily(candidate)
            if (groupingFamily && candidateFamily && candidateFamily !== groupingFamily) break
            groupingFamily ??= candidateFamily
            entries.push(candidate)
            cursor += 1
        }

        // A clipped window can leave an activity from an existing group at
        // either edge. Keep the assistant group so the same source does not
        // acquire a second identity as a system row.
        const clippedActivityGroup = entries.length === 1 && entry.kind === 'agent-event'
            && ((index === 0 && options.hasMoreMessages) || cursor === blocks.length)
            ? previousGroups.find(group => group.steps?.some(({ block }) => block.kind === 'agent-event' && block.id === entry.id))
            : undefined
        if (entries.length < 2 && groupingFamily !== 'codex-exploration' && !clippedActivityGroup) {
            visibleBlocks.push(block)
            continue
        }

        const tools: ToolCallBlock[] = []
        const steps: NonNullable<ToolGroupBlock['steps']> = []
        let reasoningRoundSummary: RoundSummary | undefined
        for (const member of entries) {
            if (member.kind === 'tool-call') tools.push(member)
            else steps.push({ beforeToolIndex: tools.length, block: member })
            if (member.kind === 'agent-reasoning') reasoningRoundSummary ??= member.roundSummary
        }
        const startsAtOldestVisibleBoundary = visibleBlocks.length === 0
        const needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        const previousBlock = visibleBlocks.at(-1)
        const activityTitle = previousBlock?.kind === 'tool-call'
            && previousBlock.tool.name === 'CodexReasoning'
            ? getInputStringAny(previousBlock.tool.input, ['title'])
            : null
        visibleBlocks.push({
            kind: 'tool-group',
            id: clippedActivityGroup?.id ?? createToolGroupId(entries, needsOlderHistory, previousGroups),
            createdAt: entry.createdAt,
            invokedAt: entry.invokedAt,
            firstToolId: tools[0]?.id,
            lastToolId: tools.at(-1)?.id,
            tools,
            ...(steps.length ? { steps } : {}),
            defaultOpen: options.toolGroupsCollapsed === false,
            historyState: needsOlderHistory ? 'needs-older-history' : 'complete',
            needsOlderHistory,
            activityTitle,
            presentationMode: groupingFamily ?? clippedActivityGroup?.presentationMode ?? 'default',
            roundSummary: tools[0]?.roundSummary ?? reasoningRoundSummary,
            summary: summarizeToolGroup(tools)
        })
        index = cursor - 1
    }

    return visibleBlocks
}
