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

    it('rejects unavailable native operations without changing approval policies or asking the model', () => {
        expect(resolve('/approve')).toContain('no permission settings were changed')
        expect(resolve('/recap')).toContain('not sent to the model')
        expect(resolve('/compact')).toContain('not supported')
        expect(resolve('/compact', 'cursor')).toContain('not supported')
        expect(resolveRemoteBuiltinCommand({ text: '/compact keep API details', flavor: 'cursor',
            customCommands: new Set(), nativeCommandSupported: true, usage: new RemoteUsageSnapshot() })).toBeNull()
    })

    it('reports only observed session usage and distinguishes missing data from zero', () => {
        const usage = new RemoteUsageSnapshot()
        expect(usage.describe()).toContain('No session usage has been reported')
        expect(usage.describe()).not.toContain('input_tokens: 0')
        usage.observe({ input_tokens: 42, output_tokens: 0, secret: 'not included', cache_read_input_tokens: NaN })
        const result = resolveRemoteBuiltinCommand({ text: '/usage', flavor: 'claude', customCommands: new Set(), usage })!
        expect(result).toContain('input_tokens: 42')
        expect(result).toContain('output_tokens: 0')
        expect(result).toContain('not account limits')
        expect(result).not.toContain('secret')
        expect(result).not.toContain('NaN')
        expect(resolve('/usage today')).toBe('Usage: /usage (no arguments)')
    })
})
