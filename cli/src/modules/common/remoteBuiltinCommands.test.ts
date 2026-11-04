import { describe, expect, it } from 'vitest'
import { parseRemoteBuiltinCommand, RemoteUsageSnapshot, resolveRemoteBuiltinCommand } from './remoteBuiltinCommands'

describe('remote builtin command routing', () => {
    const resolve = (text: string, flavor = 'agy', customCommands = new Set<string>()) =>
        resolveRemoteBuiltinCommand({ text, flavor, customCommands, usage: new RemoteUsageSnapshot() })

    it('does not interpret paths or longer command names as builtins', () => {
        expect(parseRemoteBuiltinCommand('/compact.md')).toBeNull()
        expect(parseRemoteBuiltinCommand('/usage-report')).toBeNull()
        expect(parseRemoteBuiltinCommand('Explain /approve')).toBeNull()
    })

    it('preserves custom commands and Codex native routing', () => {
        expect(resolve('/recap recent changes', 'claude', new Set(['recap']))).toBeNull()
        expect(resolve('/approve', 'codex')).toBeNull()
        expect(resolve('/compact focus on API', 'claude')).toBeNull()
        expect(resolve('/compact', 'dsh')).toBeNull()
    })

    it('uses provider approval controls and preserves native approve commands', () => {
        expect(resolve('/approve', 'claude')).toBe('Review pending requests in chat.')
        expect(resolve('/approve', 'pi')).toContain('Manual approval is unavailable')
        expect(resolveRemoteBuiltinCommand({ text: '/approve', flavor: 'dsh', customCommands: new Set(),
            nativeCommands: ['permission'], usage: new RemoteUsageSnapshot() })).toContain('/permission')
        expect(resolveRemoteBuiltinCommand({ text: '/approve current-action', flavor: 'cursor', customCommands: new Set(),
            nativeCommandSupported: true, usage: new RemoteUsageSnapshot() })).toBeNull()
        expect(resolve('/recap')).toContain('unavailable for this provider')
        expect(resolve('/compact')).toContain('unavailable for this provider')
        expect(resolve('/compact', 'cursor')).toContain('unavailable for this provider')
        expect(resolveRemoteBuiltinCommand({ text: '/compact keep API details', flavor: 'cursor',
            customCommands: new Set(), nativeCommandSupported: true, usage: new RemoteUsageSnapshot() })).toBeNull()
    })

    it('reports only observed session usage and distinguishes missing data from zero', () => {
        const usage = new RemoteUsageSnapshot()
        expect(usage.describe()).toContain('Session usage unavailable')
        expect(usage.describe()).not.toContain('input_tokens: 0')
        usage.observe({ input_tokens: 42, output_tokens: 0, secret: 'not included', cache_read_input_tokens: NaN })
        const result = resolveRemoteBuiltinCommand({ text: '/usage', flavor: 'claude', customCommands: new Set(), usage })!
        expect(result).toContain('Input tokens: 42')
        expect(result).toContain('Output tokens: 0')
        expect(result).not.toContain('Account limits')
        expect(result).not.toContain('input_tokens')
        expect(result).not.toContain('secret')
        expect(result).not.toContain('NaN')
        expect(resolve('/usage today')).toBe('Usage: /usage (no arguments)')
    })

    it('distinguishes remaining context space from account limits and keeps tokens through context-only updates', () => {
        const usage = new RemoteUsageSnapshot()
        usage.observe({ inputTokens: 1000, outputTokens: 200, costUsd: 0.1234 })
        usage.observe({ contextTokens: 1200, modelContextWindow: 200000 })
        expect(usage.describe()).toContain('Input tokens: 1,000')
        expect(usage.describe()).toContain('Available context space: 198,800 tokens')
        expect(usage.describe()).toContain('Reported cost: $0.12')
        expect(usage.describe()).not.toContain('Account limits')
        usage.observe({ contextTokens: 1200, context_window: 1000000, context_window_source: 'model-suffix' })
        expect(usage.describe()).not.toContain('Available context space')
        usage.observe({ modelContextWindow: 30000 })
        expect(usage.describe()).not.toContain('Available context space')
    })

    it('shows genuine reported account utilization separately and does not reuse an expired window', () => {
        const usage = new RemoteUsageSnapshot()
        usage.observeRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.25, resetsAt: 4102444800 })
        expect(usage.describe()).toContain('5-hour limit · remaining 75%')
        usage.observeRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1 })
        expect(usage.describe()).toContain('remaining quota unavailable')
        expect(usage.describe()).not.toContain('remaining 75%')
    })
})
