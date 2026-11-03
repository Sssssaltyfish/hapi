import { isObject } from '@hapi/protocol'

export type ContextUsage = { used: number; max: number | null; cacheRead?: number }

function tokens(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Codex's last total is the active context; the session total is spending. */
export function codexContextUsage(value: unknown): ContextUsage | null {
    if (!isObject(value)) return null
    const last = value.last ?? value.lastTokenUsage ?? value.last_token_usage
    const usage = isObject(last) ? last : null
    const used = tokens(value.contextTokens ?? value.context_tokens)
        ?? tokens(usage?.totalTokens ?? usage?.total_tokens)
    if (used === null) return null
    const max = tokens(value.modelContextWindow ?? value.model_context_window)
    return {
        used,
        max: max && max > 0 ? max : null,
        cacheRead: tokens(usage?.cachedInputTokens ?? usage?.cached_input_tokens) ?? undefined,
    }
}
