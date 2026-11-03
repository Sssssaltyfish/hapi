import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'
import type { ContextUsage } from './contextUsage'

export type SessionContextSnapshot = {
    usage: ContextUsage
    model: string | null
    at: number
    seq: number
}

/** One latest provider snapshot, independent of the materialized history window. */
export function mergeSessionContextUsage(previous: SessionContextSnapshot | null, messages: readonly DecryptedMessage[]): SessionContextSnapshot | null {
    let current = previous
    const candidates = messages.flatMap(message => {
        if (typeof message.seq !== 'number') return []
        const envelope = unwrapRoleWrappedRecordEnvelope(message.content)
        if (envelope?.role !== 'agent' || !isObject(envelope.content)) return []
        const data = envelope.content.data
        if (!isObject(data) || !['token_count', 'assistant', 'system'].includes(String(data.type))) return []
        return [{ message, data, at: message.invokedAt ?? message.createdAt, seq: message.seq }]
    }).sort((a, b) => a.at - b.at || a.seq - b.seq)
    for (const { message, data, at, seq } of candidates) {
        if (current && (at < current.at || at === current.at && seq < current.seq)) continue
        if (data.type === 'system') {
            // Claude's result reports the real model limit after turn one.
            // Never treat aggregate model token spending as current occupancy.
            if (!current?.model || data.subtype !== 'turn_duration' || data.isSidechain || data.parentToolUseId) continue
            const summary = isObject(data.resultSummary) ? data.resultSummary : null
            const models = isObject(summary?.modelUsage) ? summary.modelUsage : null
            const modelValue = models?.[current.model]
            const model = isObject(modelValue) ? modelValue : null
            const limit = model?.contextWindow
            if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0) {
                current = { ...current, usage: { ...current.usage, max: limit }, at, seq }
            }
            continue
        }
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized) continue
        const usage = normalized.usage
        if (!usage || usage.context_tokens === null || normalized.isSidechain || normalized.parentToolUseId || usage.scope_role === 'child') continue
        const used = usage.context_tokens ?? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
        if (!Number.isSafeInteger(used) || used < 0) continue
        const model = normalized.model ?? null
        const reportedLimit = usage.context_window_source !== 'estimate' ? usage.context_window : undefined
        const max = typeof reportedLimit === 'number' && Number.isSafeInteger(reportedLimit) && reportedLimit > 0
            ? reportedLimit
            : usage.context_window_source !== 'estimate' && model && current?.model === model ? current.usage.max : null
        current = { usage: { used, max, cacheRead: usage.cache_read_input_tokens }, model, at, seq }
    }
    return current
}
