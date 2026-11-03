export type RemoteBuiltinCommand = 'compact' | 'approve' | 'recap' | 'usage'
const customSlashMessages = new WeakSet<object>()

export function markCustomSlashMessage(message: object): void { customSlashMessages.add(message) }
export function isCustomSlashMessage(message: object): boolean { return customSlashMessages.has(message) }

export function parseRemoteBuiltinCommand(text: string): { name: RemoteBuiltinCommand; args: string } | null {
    const match = /^\/(compact|approve|recap|usage)(?:\s+([\s\S]*))?$/.exec(text.trim())
    return match ? { name: match[1] as RemoteBuiltinCommand, args: match[2]?.trim() ?? '' } : null
}

type UsageSnapshot = Record<string, number>
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'totalTokens',
    'contextTokens', 'modelContextWindow', 'total_cost_usd', 'duration_ms'] as const

/** Only facts already emitted by the running provider; this is not an account quota API. */
export class RemoteUsageSnapshot {
    private latest: UsageSnapshot | null = null

    observe(raw: unknown): void {
        if (!raw || typeof raw !== 'object') return
        const value = raw as Record<string, unknown>
        const snapshot: UsageSnapshot = {}
        for (const field of TOKEN_FIELDS) {
            const count = value[field]
            if (typeof count === 'number' && Number.isFinite(count) && count >= 0) snapshot[field] = count
        }
        if (Object.keys(snapshot).length) this.latest = snapshot
    }

    describe(): string {
        if (!this.latest) return 'No session usage has been reported by this provider yet. Account limits are not available through this runner.'
        return 'Latest reported session usage (not account limits):\n'
            + Object.entries(this.latest).map(([field, value]) => `${field}: ${value}`).join('\n')
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
    if (command.name === 'approve') return '/approve is not supported by this provider runner. It requires a native one-time retry of the most recently rejected action; no permission settings were changed.'
    return `/${command.name} is not supported by this provider runner. The command was not sent to the model.`
}
