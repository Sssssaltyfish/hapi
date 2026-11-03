import type { AgentState, SlashCommand } from '@/types/api'
import type { ToolCallBlock } from '@/chat/types'
import { ensureToolBlock } from '@/chat/reducerTools'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'

const commandName = (name: string) => name.trim().replace(/^\//, '').toLowerCase()

export function providerOwnsApprove(commands: readonly SlashCommand[], nativeCommands: readonly string[] = []): boolean {
    return nativeCommands.some(name => commandName(name) === 'approve')
        || commands.some(command => commandName(command.name) === 'approve' && command.source !== 'builtin')
}

/** The pending request map is authoritative; ordinary questions are separate controls. */
export function pendingApprovalBlock(state: AgentState | null | undefined, requestId?: string): ToolCallBlock | null {
    const entry = Object.entries(state?.requests ?? {}).filter(([id, request]) =>
        (!requestId || id === requestId) && !state?.completedRequests?.[id]
        && !isAskUserQuestionToolName(request.tool) && !isRequestUserInputToolName(request.tool))
        .sort(([a, left], [b, right]) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || a.localeCompare(b))[0]
    if (!entry) return null
    const [id, request] = entry
    return ensureToolBlock([], new Map(), request.toolCallId ?? id, {
        createdAt: request.createdAt ?? 0, localId: null, name: request.tool,
        input: request.arguments, description: null,
        permission: { id, status: 'pending', createdAt: request.createdAt },
    })
}

export async function submitApproveCommand(input: {
    text: string; flavor: string; active: boolean; state: AgentState | null | undefined
    commands: readonly SlashCommand[]; nativeCommands?: readonly string[]
    resolveCommands?: () => Promise<readonly SlashCommand[] | null>
    open: (requestId: string) => void
}): Promise<'handled' | 'unhandled'> {
    if (input.flavor === 'codex' || !input.active || !/^\s*\/approve\s*$/i.test(input.text)) return 'unhandled'
    if (providerOwnsApprove(input.commands, input.nativeCommands)) return 'unhandled'
    const pending = pendingApprovalBlock(input.state)
    if (!pending) return 'unhandled'
    const commands = input.resolveCommands ? await input.resolveCommands().catch(() => null) : input.commands
    // An unavailable provider directory cannot establish that its command is absent.
    if (!commands || providerOwnsApprove(commands, input.nativeCommands)) return 'unhandled'
    if (!commands.some(command => commandName(command.name) === 'approve' && command.source === 'builtin')) return 'unhandled'
    input.open(pending.tool.permission!.id)
    return 'handled'
}
