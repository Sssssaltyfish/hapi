import { describe, expect, test } from 'bun:test'
import { normalizeSessionRecap, SESSION_RECAP_MAX_CHARACTERS } from './recap'

describe('session recap text', () => {
    test('keeps a short recap on one line', () => {
        expect(normalizeSessionRecap('  Fixed the import.\n\nNext: run the build.  ')).toBe('Fixed the import. Next: run the build.')
    })
    test('caps long output without splitting a Unicode surrogate pair', () => {
        const recap = normalizeSessionRecap('😀'.repeat(250))
        expect(recap.length).toBeLessThanOrEqual(SESSION_RECAP_MAX_CHARACTERS)
        expect(recap.endsWith('…')).toBe(true)
        expect(recap).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
    })
})
