import { describe, expect, it } from 'vitest'
import { resolveAgyModelSelection } from './agyModelSelection'

const catalog = ['gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low']

describe('AGY model and effort selection', () => {
    it('switches the concrete variant with effort and accepts an explicit model on its own', () => {
        expect(resolveAgyModelSelection('gemini-4-argon-high', 'medium', catalog))
            .toEqual({ model: 'gemini-4-argon-medium', effort: 'medium' })
        expect(resolveAgyModelSelection('gemini-4-argon-low', null, catalog))
            .toEqual({ model: 'gemini-4-argon-low', effort: 'low' })
    })

    it('rejects unpublished tiers instead of borrowing another model family’s levels', () => {
        expect(() => resolveAgyModelSelection('gemini-4-argon-high', 'max', catalog)).toThrow('available: low, medium, high')
        expect(() => resolveAgyModelSelection('gemini-3.1-pro-high', 'medium', catalog)).toThrow('available: low, high')
    })

    it('leaves unknown custom identifiers and the implicit model to AGY', () => {
        expect(resolveAgyModelSelection('custom-model-high', 'max', catalog)).toEqual({ model: 'custom-model-high', effort: 'max' })
        expect(resolveAgyModelSelection(null, 'medium', catalog)).toEqual({ model: null, effort: 'medium' })
    })
})
