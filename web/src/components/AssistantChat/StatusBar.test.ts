import { describe, expect, it } from 'vitest'
import {
    formatContextUsageLabel,
    getContextWarning,
    shouldShowCodexFastBadge
} from './StatusBar'

describe('context warning colors', () => {
    it('keeps usage below 70% muted', () => {
        expect(getContextWarning(69, 100).color).toBe('text-[var(--app-hint)]')
    })

    it('shows a warning from 70% through below 90%', () => {
        expect(getContextWarning(70, 100).color).toBe('text-amber-500')
        expect(getContextWarning(89, 100).color).toBe('text-amber-500')
    })

    it('shows danger at 90% and above', () => {
        expect(getContextWarning(90, 100).color).toBe('text-red-500')
        expect(getContextWarning(95, 100).color).toBe('text-red-500')
    })
})

describe('context usage labels', () => {
    it('expresses actual used capacity as a percentage', () => {
        expect(formatContextUsageLabel(90_000, 258_000)).toBe('ctx 35%')
        expect(formatContextUsageLabel(110, 100)).toBe('ctx 110%')
    })

    it('switches to the same actual numerator and denominator', () => {
        expect(formatContextUsageLabel(186_000, 262_000, true)).toBe('ctx 186k / 262k')
    })

    it('reports only the known usage when a provider has not supplied a limit', () => {
        expect(formatContextUsageLabel(90_000, null)).toBe('ctx 90k')
    })
})

describe('shouldShowCodexFastBadge', () => {
    it('uses only the effective service tier', () => {
        expect(shouldShowCodexFastBadge('codex', undefined)).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'standard')).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'fast')).toBe(true)
        expect(shouldShowCodexFastBadge('codex', 'priority')).toBe(true)
        expect(shouldShowCodexFastBadge('claude', 'fast')).toBe(false)
    })
})
