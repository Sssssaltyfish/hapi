// Effort levels Claude Code's `--effort` flag accepts, in ascending order.
// "auto"/null is hapi's sentinel for omitting --effort (model default), not a level here.
export const CLAUDE_EFFORT_LABELS = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max'
} as const

export type ClaudeEffortLevel = keyof typeof CLAUDE_EFFORT_LABELS
export const CLAUDE_EFFORT_LEVELS = Object.keys(CLAUDE_EFFORT_LABELS) as ClaudeEffortLevel[]

// Values accepted by Antigravity's independent `--effort` CLI option.
export const AGY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgyEffortLevel = typeof AGY_EFFORT_LEVELS[number]

export function isAgyEffortLevel(value: unknown): value is AgyEffortLevel {
    return typeof value === 'string' && (AGY_EFFORT_LEVELS as readonly string[]).includes(value)
}
