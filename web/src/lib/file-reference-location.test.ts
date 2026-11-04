import { describe, expect, it } from 'vitest'
import { parseFileReferenceLocation } from './file-reference-location'

describe('file reference locations', () => {
    it.each([
        ['/home/igna/project/main.ts:42', '/home/igna/project/main.ts', 42],
        ['/home/igna/project/main.ts#L42', '/home/igna/project/main.ts', 42],
        ['/home/igna/project/main.ts#L42-L48', '/home/igna/project/main.ts', 42],
        ['C:\\project\\main.ts:42:3', 'C:\\project\\main.ts', 42],
        ['/home/igna/my%20project/main.ts:42', '/home/igna/my project/main.ts', 42],
    ])('retains the path and source line in %s', (input, path, line) => {
        expect(parseFileReferenceLocation(input)).toEqual({ path, line })
    })
    it('preserves a Windows path without a location', () => {
        expect(parseFileReferenceLocation('C:\\project\\main.ts')).toEqual({ path: 'C:\\project\\main.ts' })
    })
    it('preserves a prose fragment without treating it as a source line', () => {
        expect(parseFileReferenceLocation('/home/igna/readme.md#overview')).toEqual({ path: '/home/igna/readme.md#overview' })
    })
})
