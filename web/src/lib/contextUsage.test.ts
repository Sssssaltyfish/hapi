import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { codexContextUsage } from './contextUsage'
import { mergeSessionContextUsage } from './sessionContextUsage'

const message = (seq: number, data: Record<string, unknown>): DecryptedMessage => ({
    id: `context-${seq}`, localId: null, seq, createdAt: seq * 1000,
    content: { role: 'agent', content: { type: 'output', data } },
})

describe('reported context occupancy', () => {
    it('uses Codex last total once, and excludes cumulative bills or absent usage', () => {
        expect(codexContextUsage({ last: { inputTokens: 49900, cachedInputTokens: 46000, outputTokens: 200, reasoningOutputTokens: 100, totalTokens: 50100 }, total: { totalTokens: 9_000_000 }, modelContextWindow: 200000 }))
            .toEqual({ used: 50100, max: 200000, cacheRead: 46000 })
        expect(codexContextUsage({ total: { inputTokens: 9_000_000, totalTokens: 9_100_000 }, modelContextWindow: 200000 })).toBeNull()
        expect(codexContextUsage({})).toBeNull()
        expect(codexContextUsage({ last: { totalTokens: -1 }, modelContextWindow: 200000 })).toBeNull()
        expect(codexContextUsage({ contextTokens: 0, modelContextWindow: 200000 })).toMatchObject({ used: 0, max: 200000 })
    })

    it('learns Claude actual limits from results without using billing totals or seeded estimates', () => {
        const assistant = message(1, { type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Answer' }], usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 400, context_window: 1_000_000, context_window_source: 'estimate' } } })
        const initial = mergeSessionContextUsage(null, [assistant])
        expect(initial?.usage).toMatchObject({ used: 1400, max: null })
        const result = message(2, { type: 'system', subtype: 'turn_duration', resultSummary: { modelUsage: { 'claude-fable-5': { inputTokens: 8_000_000, contextWindow: 500000 } } } })
        const reported = mergeSessionContextUsage(initial, [result])
        expect(reported?.usage).toMatchObject({ used: 1400, max: 500000 })
        expect(mergeSessionContextUsage(reported, [assistant])).toBe(reported)
        const child = message(3, { type: 'system', subtype: 'turn_duration', isSidechain: true, resultSummary: { modelUsage: { 'claude-fable-5': { contextWindow: 100000 } } } })
        expect(mergeSessionContextUsage(reported, [child])).toBe(reported)
        expect(mergeSessionContextUsage(reported, [{ ...assistant, id: 'switched-variant', seq: 4, createdAt: 4000 }])?.usage.max).toBeNull()
    })

    it('preserves legacy usage accounting while filtering cumulative records only from the status snapshot', () => {
        const token = (seq: number, info: Record<string, unknown>): DecryptedMessage => ({
            ...message(seq, {}),
            content: { role: 'agent', content: { type: 'codex', data: { type: 'token_count', info } } },
        })
        const context = mergeSessionContextUsage(null, [token(1, { last: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, modelContextWindow: 200000 })])
        const cumulative = token(2, { total: { inputTokens: 9_000_000, outputTokens: 1000 }, modelContextWindow: 200000 })
        expect(normalizeDecryptedMessage(cumulative)?.usage).toMatchObject({ input_tokens: 9_000_000, output_tokens: 1000, context_tokens: 9_000_000 })
        expect(context?.usage).toMatchObject({ used: 1000, max: 200000 })
        expect(mergeSessionContextUsage(context, [cumulative])).toBe(context)
    })
})
