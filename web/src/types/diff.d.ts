declare module 'diff' {
    export type Change = {
        value: string
        added?: boolean
        removed?: boolean
    }

    type StructuredPatchHunk = {
        oldStart: number
        oldLines: number
        newStart: number
        newLines: number
        lines: string[]
    }

    export function diffLines(oldStr: string, newStr: string): Change[]
    export function parsePatch(patch: string): { hunks: StructuredPatchHunk[] }[]
}

