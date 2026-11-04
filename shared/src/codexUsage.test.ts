import { expect, test } from 'bun:test'
import { CodexUsageSnapshotSchema, codexMicroAmount, codexUsageSummary, normalizeCodexUsage } from './codexUsage'

test('projects every quota bucket with remaining percentages, without treating historical tokens as a quota balance', () => {
    const snapshot = normalizeCodexUsage({ summary: { lifetimeTokens: 1_000_000 }, threadUsage: {
        threadId: 'thread', estimatedUsageCreditsMicros: 1_234_567, estimatedUsageUsdMicros: null, groups: [],
    } }, {
        ordinaryUsageAllowed: false,
        rateLimits: { limitId: 'codex', primary: { usedPercent: 25 } },
        rateLimitsByLimitId: {
            codex: { limitName: 'Codex', planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
                secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: null },
                credits: { hasCredits: true, unlimited: false, balance: '9.25' },
                individualLimit: { limit: '100', used: '20', remainingPercent: 80, resetsAt: 200 } },
            reviews: { primary: { usedPercent: 10 } },
        },
    }, {}, 1_000_000)
    expect(snapshot.limits).toHaveLength(2)
    expect(snapshot.limits[0]).toMatchObject({ name: 'Codex', plan: 'pro', primary: { remainingPercent: 75, usedPercent: 25 },
        secondary: { remainingPercent: 40 }, credits: { balance: '9.25' }, spending: { remainingPercent: 80 } })
    expect(snapshot.limits[1].primary?.remainingPercent).toBe(90)
    expect(snapshot.ordinaryUsageAllowed).toBe(false)
    expect(snapshot.summary?.lifetimeTokens).toBe('1000000')
    expect(snapshot.thread?.creditsMicros).toBe('1234567')
    expect(JSON.stringify(snapshot.limits)).not.toContain('Tokens')
    expect(CodexUsageSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(codexUsageSummary(snapshot)).toContain('75% remaining')
    expect(codexUsageSummary(snapshot)).not.toContain('{')
})

test('preserves exact large counts and micro amounts while refusing imprecise JSON integers', () => {
    const snapshot = normalizeCodexUsage({ summary: { lifetimeTokens: 9_007_199_254_740_992, peakDailyTokens: '9007199254740993' },
        threadUsage: { threadId: 'thread', estimatedUsageCreditsMicros: '9007199254740993123456', groups: [
            { model: 'model', estimatedUsageCreditsMicros: 0, cachedInputTokens: 0, totalTokens: null },
        ] } }, { rateLimits: { primary: { usedPercent: 125 } } })
    expect(snapshot.summary).toMatchObject({ lifetimeTokens: null, peakDailyTokens: '9007199254740993' })
    expect(codexMicroAmount(snapshot.thread!.creditsMicros!)).toBe('9007199254740993.123456')
    expect(snapshot.thread?.groups[0]).toMatchObject({ creditsMicros: '0', cachedInputTokens: '0', totalTokens: null })
    expect(snapshot.limits[0].primary).toMatchObject({ usedPercent: 125, remainingPercent: 0 })
})

test('keeps unavailable values unknown, including invalid percentages and missing absolute token allowances', () => {
    const snapshot = normalizeCodexUsage(null, { rateLimits: { primary: { usedPercent: -1 } } }, { usage: 'Not provided for this account' })
    expect(snapshot.ordinaryUsageAllowed).toBeNull()
    expect(snapshot.limits[0].primary).toEqual({ usedPercent: null, remainingPercent: null, durationMins: null, resetsAt: null })
    expect(snapshot.thread).toBeNull()
    expect(snapshot.summary).toBeNull()
    expect(snapshot.daily).toBeNull()
    expect(snapshot.unavailable.usage).toBe('Not provided for this account')
    expect(CodexUsageSnapshotSchema.safeParse({ ...snapshot, limits: 'invalid' }).success).toBe(false)
})
