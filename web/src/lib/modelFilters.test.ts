import { describe, expect, it } from 'vitest'
import { filterModelOptions, matchesModelFilter } from './modelFilters'

describe('model filters', () => {
    it('matches provider IDs or names, treats punctuation literally, and allows multiple patterns', () => {
        expect(matchesModelFilter('gemini-4-hydrogen-xhigh', 'Hydrogen', ['gemini-*'])).toBe(true)
        expect(matchesModelFilter('claude-sonnet-5-5', 'Sonnet', ['gemini-*'])).toBe(false)
        expect(matchesModelFilter('sonnet[1m]', 'Sonnet 1M', ['sonnet[1m]'])).toBe(true)
        expect(matchesModelFilter('opaque-id', 'Gemini 4 Hydrogen', ['opus', 'gemini*'])).toBe(true)
    })

    it('preserves defaults and a selected model while hiding unrelated choices', () => {
        const options = [
            { value: null, label: 'Default' },
            { value: 'gemini-4-hydrogen-xhigh', label: 'Hydrogen' },
            { value: 'claude-sonnet-5-5', label: 'Sonnet' },
            { value: 'gpt-6.1-sol', label: 'Sol' },
        ]
        expect(filterModelOptions(options, ['gemini-*'], 'claude-sonnet-5-5')).toEqual(options.slice(0, 3))
        expect(filterModelOptions(options, [])).toBe(options)
    })
})
