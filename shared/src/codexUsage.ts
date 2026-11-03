import { z } from 'zod'

export type CodexUsageWindow = {
    usedPercent: number | null
    remainingPercent: number | null
    durationMins: number | null
    resetsAt: number | null
}

export type CodexUsageLimit = {
    id: string | null
    name: string | null
    model: string | null
    plan: string | null
    primary: CodexUsageWindow | null
    secondary: CodexUsageWindow | null
    credits: { available: boolean | null; unlimited: boolean | null; balance: string | null } | null
    spending: { limit: string | null; used: string | null; remainingPercent: number | null; resetsAt: number | null } | null
    spendControlReached: boolean | null
    reachedReason: string | null
}

export type CodexUsageGroup = {
    model: string | null
    reasoning: string | null
    speed: string | null
    creditsMicros: string | null
    newInputTokens: string | null
    cachedInputTokens: string | null
    inputTokens: string | null
    outputTokens: string | null
    totalTokens: string | null
}

export type CodexUsageSnapshot = {
    readAt: number
    ordinaryUsageAllowed: boolean | null
    limits: CodexUsageLimit[]
    resetCredits: { available: string | null; credits: Array<{
        id: string
        type: string | null
        status: string | null
        grantedAt: number | null
        expiresAt: number | null
        title: string | null
        description: string | null
    }> | null } | null
    summary: {
        lifetimeTokens: string | null
        peakDailyTokens: string | null
        longestTurnSeconds: string | null
        currentStreakDays: string | null
        longestStreakDays: string | null
    } | null
    daily: Array<{ date: string; tokens: string }> | null
    thread: { id: string; creditsMicros: string | null; usdMicros: string | null; groups: CodexUsageGroup[] } | null
    unavailable: { usage?: string; rateLimits?: string }
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : {}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim().length > 0 ? value : null
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null

/** JSON integers beyond the safe range have already lost precision; never turn them into an exact-looking count. */
function count(value: unknown): string | null {
    if (typeof value === 'bigint' && value >= 0n) return value.toString()
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
    return typeof value === 'string' && /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : null
}

function window(value: unknown): CodexUsageWindow | null {
    if (value === null || typeof value !== 'object') return null
    const raw = record(value)
    const used = number(raw.usedPercent)
    return {
        usedPercent: used,
        // Percent of a quota window, never a remaining token count or permission to resume.
        remainingPercent: used === null ? null : Math.max(0, 100 - used),
        durationMins: number(raw.windowDurationMins),
        resetsAt: number(raw.resetsAt),
    }
}

function limit(value: unknown, id: string | null): CodexUsageLimit {
    const raw = record(value)
    const credits = record(raw.credits)
    const spending = record(raw.individualLimit)
    const remaining = number(spending.remainingPercent)
    return {
        id: text(raw.limitId) ?? id,
        name: text(raw.limitName),
        model: text(raw.normalModelSlug),
        plan: text(raw.planType),
        primary: window(raw.primary),
        secondary: window(raw.secondary),
        credits: raw.credits && typeof raw.credits === 'object' ? {
            available: boolean(credits.hasCredits), unlimited: boolean(credits.unlimited), balance: text(credits.balance),
        } : null,
        spending: raw.individualLimit && typeof raw.individualLimit === 'object' ? {
            limit: text(spending.limit), used: text(spending.used), remainingPercent: remaining !== null && remaining <= 100 ? remaining : null,
            resetsAt: number(spending.resetsAt),
        } : null,
        spendControlReached: boolean(raw.spendControlReached),
        reachedReason: text(raw.rateLimitReachedType),
    }
}

export function normalizeCodexUsage(usageValue: unknown, limitsValue: unknown,
    unavailable: CodexUsageSnapshot['unavailable'] = {}, readAt = Date.now()): CodexUsageSnapshot {
    const usage = record(usageValue)
    const rates = record(limitsValue)
    const summary = record(usage.summary)
    const thread = record(usage.threadUsage)
    const reset = record(rates.rateLimitResetCredits)
    const multi = Object.entries(record(rates.rateLimitsByLimitId)).filter(([, value]) => value !== null && typeof value === 'object')
    const snapshot: CodexUsageSnapshot = {
        readAt,
        ordinaryUsageAllowed: boolean(rates.ordinaryUsageAllowed),
        // The single bucket mirrors the multi-bucket payload. Prefer the complete catalog without duplicating its legacy alias.
        limits: multi.length ? multi.map(([id, value]) => limit(value, id))
            : Object.keys(record(rates.rateLimits)).length ? [limit(rates.rateLimits, null)] : [],
        resetCredits: rates.rateLimitResetCredits && typeof rates.rateLimitResetCredits === 'object' ? {
            available: count(reset.availableCount),
            credits: Array.isArray(reset.credits) ? reset.credits.flatMap(value => {
                const credit = record(value)
                const id = text(credit.id)
                return id ? [{ id, type: text(credit.resetType), status: text(credit.status),
                    grantedAt: number(credit.grantedAt), expiresAt: number(credit.expiresAt),
                    title: text(credit.title), description: text(credit.description) }] : []
            }) : null,
        } : null,
        summary: usage.summary && typeof usage.summary === 'object' ? {
            lifetimeTokens: count(summary.lifetimeTokens), peakDailyTokens: count(summary.peakDailyTokens),
            longestTurnSeconds: count(summary.longestRunningTurnSec), currentStreakDays: count(summary.currentStreakDays),
            longestStreakDays: count(summary.longestStreakDays),
        } : null,
        daily: Array.isArray(usage.dailyUsageBuckets) ? usage.dailyUsageBuckets.flatMap(value => {
            const day = record(value)
            const date = text(day.startDate)
            const tokens = count(day.tokens)
            return date && tokens !== null ? [{ date, tokens }] : []
        }) : null,
        thread: text(thread.threadId) ? {
            id: String(thread.threadId), creditsMicros: count(thread.estimatedUsageCreditsMicros), usdMicros: count(thread.estimatedUsageUsdMicros),
            groups: Array.isArray(thread.groups) ? thread.groups.map(value => {
                const group = record(value)
                return { model: text(group.model), reasoning: text(group.reasoningEffort), speed: text(group.speed),
                    creditsMicros: count(group.estimatedUsageCreditsMicros), newInputTokens: count(group.netNewInputTokens),
                    cachedInputTokens: count(group.cachedInputTokens), inputTokens: count(group.inputTokens),
                    outputTokens: count(group.outputTokens), totalTokens: count(group.totalTokens) }
            }) : [],
        } : null,
        unavailable: { ...unavailable },
    }
    if (snapshot.summary && Object.values(snapshot.summary).every(value => value === null)) snapshot.summary = null
    if (!snapshot.limits.length && !snapshot.unavailable.rateLimits) snapshot.unavailable.rateLimits = 'The native host did not provide allowance limits'
    if (!snapshot.summary && !snapshot.thread && !snapshot.daily && !snapshot.unavailable.usage) snapshot.unavailable.usage = 'The native host did not provide usage totals'
    return snapshot
}

/** Exact micro-unit conversion, including large integers; never round a JSON number into a fabricated balance. */
export function codexMicroAmount(value: string): string {
    const padded = value.padStart(7, '0')
    const fraction = padded.slice(-6).replace(/0+$/, '')
    return `${padded.slice(0, -6)}${fraction ? `.${fraction}` : ''}`
}

const optionalText = z.string().nullable()
const optionalNumber = z.number().finite().nonnegative().nullable()
const optionalCount = z.string().regex(/^\d+$/).nullable()
const windowSchema = z.object({ usedPercent: optionalNumber, remainingPercent: z.number().finite().min(0).max(100).nullable(),
    durationMins: optionalNumber, resetsAt: optionalNumber })

/** Validate the structured attachment before rendering a persisted Runner event. */
export const CodexUsageSnapshotSchema: z.ZodType<CodexUsageSnapshot> = z.object({
    readAt: z.number().finite().nonnegative(),
    ordinaryUsageAllowed: z.boolean().nullable(),
    limits: z.array(z.object({
        id: optionalText, name: optionalText, model: optionalText, plan: optionalText,
        primary: windowSchema.nullable(), secondary: windowSchema.nullable(),
        credits: z.object({ available: z.boolean().nullable(), unlimited: z.boolean().nullable(), balance: optionalText }).nullable(),
        spending: z.object({ limit: optionalText, used: optionalText, remainingPercent: optionalNumber, resetsAt: optionalNumber }).nullable(),
        spendControlReached: z.boolean().nullable(), reachedReason: optionalText,
    })),
    resetCredits: z.object({ available: optionalCount, credits: z.array(z.object({
        id: z.string(), type: optionalText, status: optionalText, grantedAt: optionalNumber,
        expiresAt: optionalNumber, title: optionalText, description: optionalText,
    })).nullable() }).nullable(),
    summary: z.object({ lifetimeTokens: optionalCount, peakDailyTokens: optionalCount,
        longestTurnSeconds: optionalCount, currentStreakDays: optionalCount, longestStreakDays: optionalCount }).nullable(),
    daily: z.array(z.object({ date: z.string(), tokens: z.string().regex(/^\d+$/) })).nullable(),
    thread: z.object({ id: z.string(), creditsMicros: optionalCount, usdMicros: optionalCount, groups: z.array(z.object({
        model: optionalText, reasoning: optionalText, speed: optionalText, creditsMicros: optionalCount,
        newInputTokens: optionalCount, cachedInputTokens: optionalCount, inputTokens: optionalCount,
        outputTokens: optionalCount, totalTokens: optionalCount,
    })) }).nullable(),
    unavailable: z.object({ usage: z.string().optional(), rateLimits: z.string().optional() }),
})

/** Readable fallback for clients that do not render the optional structured attachment. */
export function codexUsageSummary(snapshot: CodexUsageSnapshot): string {
    const lines = ['Codex usage']
    for (const quota of snapshot.limits) {
        const windows = [quota.primary?.remainingPercent, quota.secondary?.remainingPercent]
            .map((value, index) => value == null ? null : `${index === 0 ? 'Primary' : 'Secondary'} ${value}% remaining`)
            .filter(Boolean)
        lines.push(`${quota.name ?? quota.id ?? 'Allowance'}: ${windows.join('; ') || 'remaining allowance unavailable'}`)
    }
    if (snapshot.thread?.creditsMicros !== null && snapshot.thread?.creditsMicros !== undefined) {
        lines.push(`Estimated thread credits consumed: ${codexMicroAmount(snapshot.thread.creditsMicros)}`)
    }
    if (snapshot.ordinaryUsageAllowed === false) lines.push('Included usage: unavailable')
    for (const error of Object.values(snapshot.unavailable)) if (error) lines.push(error)
    lines.push(`Read at ${new Date(snapshot.readAt).toISOString()}`)
    return lines.join('\n')
}
