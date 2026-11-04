export const MAX_CODEX_GOAL_OBJECTIVE_CHARS = 4_000

export type CodexThreadCommand =
    | { command: 'plan'; mode: 'plan' | 'default'; prompt?: string }
    | { command: 'goal'; action: 'show' | 'pause' | 'resume' | 'clear' }
    | { command: 'goal'; action: 'set'; objective: string }
    | { command: 'compact' | 'recap' | 'usage' }
    | { command: 'approve'; action: 'show' }
    | { command: 'approve'; action: 'retry'; reviewId: string }

export type NativeGoal = {
    threadId: string
    objective: string
    status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
    tokenBudget: number | null
    tokensUsed: number
    timeUsedSeconds: number
    createdAt: number
    updatedAt: number
}

export type NativePlanPreset = {
    name: string
    mode: 'plan' | 'default'
    model: string | null
    reasoning_effort: string | null
}

export type NativeCommandState = {
    capabilities: { plan: boolean; goal: boolean }
    planPresets: NativePlanPreset[]
    collaborationMode: Record<string, unknown> | null
    goal: NativeGoal | null
    unavailable: { plan?: string; goal?: string }
}

export type NativeCommandRequest = {
    command: CodexThreadCommand
    clientId?: string
    attachments?: Array<{ path: string }>
}

export type NativeCommandResult =
    | { command: 'plan'; applied: Record<string, unknown>; submission?: Record<string, unknown> & { accepted: true; startError?: string } }
    | { command: 'goal'; action: 'show' | 'set' | 'pause' | 'resume'; goal: NativeGoal | null; cleared?: never }
    | { command: 'goal'; action: 'clear'; cleared: boolean; goal?: never }
    | { command: 'compact'; accepted: true }
    | { command: 'recap'; text: string; sourceTurnId: string }
    | { command: 'usage'; usage: Record<string, unknown> | null; rateLimits: Record<string, unknown> | null; unavailable: { usage?: string; rateLimits?: string } }
    | { command: 'approve'; action: 'show'; denial: { reviewId: string; turnId: string; action: Record<string, unknown>; rationale: string | null } | null }
    | { command: 'approve'; action: 'retry'; reviewId: string; accepted: true }

export function parseCodexThreadCommand(text: string): CodexThreadCommand | null {
    const match = /^\/(plan|goal|compact|recap|usage|approve)(?:\s+([\s\S]*))?$/i.exec(text.trim())
    if (!match) return null

    const argument = (match[2] ?? '').trim()
    const command = match[1].toLowerCase()
    if (command === 'compact' || command === 'recap' || command === 'usage') return argument ? null : { command }
    if (command === 'approve') {
        if (!argument) return { command, action: 'show' }
        return /^\S+$/.test(argument) ? { command, action: 'retry', reviewId: argument } : null
    }
    if (command === 'plan') {
        return argument ? { command: 'plan', mode: 'plan', prompt: argument } : { command: 'plan', mode: 'plan' }
    }

    if (!argument) return { command: 'goal', action: 'show' }
    return { command: 'goal', action: 'set', objective: argument }
}
