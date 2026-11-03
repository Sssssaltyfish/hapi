import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
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
})
