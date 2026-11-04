import { commandNumber } from '@hapi/protocol/commandNumber'

export type RemoteBuiltinCommand = 'compact' | 'approve' | 'recap' | 'usage'
const customSlashMessages = new WeakSet<object>()

export function markCustomSlashMessage(message: object): void { customSlashMessages.add(message) }
export function isCustomSlashMessage(message: object): boolean { return customSlashMessages.has(message) }

export function parseRemoteBuiltinCommand(text: string): { name: RemoteBuiltinCommand; args: string } | null {
    const match = /^\/(compact|approve|recap|usage)(?:\s+([\s\S]*))?$/.exec(text.trim())
    return match ? { name: match[1] as RemoteBuiltinCommand, args: match[2]?.trim() ?? '' } : null
}

type TokenUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
type LimitUsage = { name: string; usedPercent?: number; resetsAt?: number; reached: boolean }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const number = (...values: unknown[]): number | undefined => values.find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) as number | undefined
const count = (value: number): string => commandNumber(value, { locale: 'en-US' })

/** Only facts already emitted by the running provider; this is not an account quota API. */
export class RemoteUsageSnapshot {
    private latest: TokenUsage | null = null
    private inputCacheSemantics: 'included' | 'excluded' | null = null
    private context: { used?: number; capacity?: number } = {}
    private cost?: number
    private duration?: number
    private messages?: number
    private readonly limits = new Map<string, LimitUsage>()

    observe(raw: unknown, flavor?: string): void {
        const outer = record(raw)
        const value = { ...record(outer.usage), ...outer }
        const snapshot: TokenUsage = {
            input: number(value.input_tokens, value.inputTokens),
            output: number(value.output_tokens, value.outputTokens),
            cacheRead: number(value.cache_read_input_tokens, value.cachedInputTokens),
            cacheWrite: number(value.cache_creation_input_tokens, value.cacheWriteInputTokens),
            total: number(value.total_tokens, value.totalTokens)
        }
        if (Object.values(snapshot).some(value => value !== undefined)) {
            this.latest = snapshot
            this.inputCacheSemantics = value.inputTokenSemantics === 'includes-cache' ? 'included'
                : flavor === 'claude' || flavor === 'claude-result' ? 'excluded' : null
        }
        const used = number(value.contextTokens, value.context_tokens)
            ?? (flavor === 'claude' && snapshot.input !== undefined
                ? snapshot.input + (snapshot.cacheRead ?? 0) + (snapshot.cacheWrite ?? 0) : undefined)
        // Some Claude records have a guessed context denominator. It must not
        // become a purported measured capacity or remaining allowance.
        const capacity = value.context_window_source && value.context_window_source !== 'provider'
            ? undefined : number(value.modelContextWindow, value.contextWindow, value.context_window)
        // Only pair occupancy and capacity from the same report: either field
        // arriving alone can be a model switch, not a fresh remaining-space fact.
        if (used !== undefined || capacity !== undefined) this.context = { used, capacity: capacity && capacity > 0 ? capacity : undefined }
        if (value.context_window_source && value.context_window_source !== 'provider') this.context.capacity = undefined
        this.cost = number(value.total_cost_usd, value.costUsd) ?? this.cost
        this.duration = number(value.duration_ms, value.durationMs)
            ?? (number(value.duration_seconds) !== undefined ? number(value.duration_seconds)! * 1000 : this.duration)
        this.messages = number(value.totalMessages) ?? this.messages
    }

    observeRateLimit(raw: unknown): void {
        const value = record(raw)
        const key = typeof value.rateLimitType === 'string' ? value.rateLimitType : 'provider'
        const names: Record<string, string> = { five_hour: '5-hour limit', seven_day: '7-day limit',
            seven_day_sonnet: '7-day Sonnet limit', seven_day_opus: '7-day Opus limit' }
        const used = number(value.utilization)
        const reset = number(value.resetsAt)
        if (used === undefined && reset === undefined && value.status !== 'rejected') return
        this.limits.set(key, { name: names[key] ?? 'Provider limit', usedPercent: used === undefined ? undefined : used * 100,
            resetsAt: reset === undefined ? undefined : reset > 1e12 ? reset : reset * 1000, reached: value.status === 'rejected' })
    }

    describe(scope = 'Latest provider report'): string {
        const sections: string[] = [`Session usage · ${scope}`]
        if (this.latest) {
            const labels: Record<keyof TokenUsage, string> = { input: 'Input tokens', output: 'Output tokens',
                cacheRead: 'Cache read tokens', cacheWrite: 'Cache write tokens', total: 'Reported total tokens' }
            if (this.inputCacheSemantics) labels.input += this.inputCacheSemantics === 'included' ? ' (including cache)' : ' (uncached)'
            sections.push('Tokens\n' + (Object.keys(labels) as Array<keyof TokenUsage>)
                .filter(key => this.latest![key] !== undefined)
                .map(key => `${labels[key]}: ${count(this.latest![key]!)}`).join('\n'))
        }
        const { used, capacity } = this.context
        if (used !== undefined || capacity !== undefined) {
            const lines: string[] = ['Context capacity']
            if (used !== undefined) lines.push(`Used: ${count(used)} tokens${capacity !== undefined ? ` of ${count(capacity)} (${count(used / capacity * 100)}%)` : ''}`)
            else if (capacity !== undefined) lines.push(`Capacity: ${count(capacity)} tokens`)
            if (used !== undefined && capacity !== undefined) lines.push(`Available context space: ${count(Math.max(0, capacity - used))} tokens`)
            sections.push(lines.join('\n'))
        }
        const costs: string[] = []
        if (this.cost !== undefined) costs.push(`Reported cost: ${commandNumber(this.cost, { prefix: '$', locale: 'en-US' })}`)
        if (this.duration !== undefined) costs.push(`Reported duration: ${this.duration < 1000 ? count(this.duration) + ' ms' : count(this.duration / 1000) + ' s'}`)
        if (costs.length) sections.push('Cost and duration\n' + costs.join('\n'))
        if (this.messages !== undefined) sections.push(`Activity\nMessages: ${count(this.messages)}`)
        if (sections.length === 1) sections.push('Session usage unavailable.')
        if (this.limits.size) {
            sections.push('Account limits and remaining quota · last reported\n' + [...this.limits.values()].map(limit => {
                const details: string[] = [limit.name]
                if (limit.resetsAt !== undefined && limit.resetsAt <= Date.now()) details.push('remaining quota unavailable')
                else if (limit.usedPercent !== undefined) details.push(`remaining ${count(Math.max(0, 100 - limit.usedPercent))}%`)
                else if (limit.reached) details.push('limit reached')
                if (limit.resetsAt !== undefined && Number.isFinite(new Date(limit.resetsAt).getTime())) details.push(`resets ${new Date(limit.resetsAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`)
                return details.join(' · ')
            }).join('\n'))
        }
        return sections.join('\n\n')
    }
}

export function resolveRemoteBuiltinCommand(options: {
    text: string
    flavor: string
    customCommands: ReadonlySet<string>
    nativeCommands?: readonly string[]
    nativeCommandSupported?: boolean
    usage: RemoteUsageSnapshot
}): string | null {
    const command = parseRemoteBuiltinCommand(options.text)
    if (!command || options.flavor === 'codex' || options.customCommands.has(command.name)) return null
    // These adapters already have dedicated native command handling. DSH
    // validates its public registry capability again at dispatch time.
    if (command.name === 'compact' && ['claude', 'pi', 'opencode', 'dsh'].includes(options.flavor)) return null
    if (options.nativeCommandSupported) return null
    // The DSH registry extension executes advertised commands without a model prompt.
    if (options.flavor === 'dsh' && options.nativeCommands?.includes(command.name)) return null
    if (command.name === 'usage') return command.args ? 'Usage: /usage (no arguments)' : options.usage.describe()
    if (command.name === 'approve') {
        if (options.flavor === 'dsh' && options.nativeCommands?.includes('permission')) {
            return 'Use /permission or session settings to choose a permission preset. Review pending tool requests in their approval cards.'
        }
        if (options.flavor === 'pi') return 'Pi runs tools automatically. Manual approval is unavailable.'
        return 'Review pending requests in chat.'
    }
    return `/${command.name} is unavailable for this provider.`
}
