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

// Values Antigravity's `--effort` option can select when a model publishes the variant.
export const AGY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgyEffortLevel = typeof AGY_EFFORT_LEVELS[number]

export function isAgyEffortLevel(value: unknown): value is AgyEffortLevel {
    return typeof value === 'string' && (AGY_EFFORT_LEVELS as readonly string[]).includes(value)
}

export function getAgyModelVariant(model: string | null | undefined): { baseModel: string; effort: AgyEffortLevel } | null {
    if (!model) return null
    const separator = model.lastIndexOf('-')
    const effort = model.slice(separator + 1)
    return separator > 0 && isAgyEffortLevel(effort)
        ? { baseModel: model.slice(0, separator), effort }
        : null
}

export function getAgyModelEffortLevels(model: string | null | undefined, catalogIds: readonly string[]): AgyEffortLevel[] {
    if (!model) return []
    const baseModel = getAgyModelVariant(model)?.baseModel ?? model
    return AGY_EFFORT_LEVELS.filter(effort => catalogIds.includes(`${baseModel}-${effort}`))
}
