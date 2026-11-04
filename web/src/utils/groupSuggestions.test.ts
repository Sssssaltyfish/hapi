import { expect, it } from 'vitest'
import { groupSuggestions } from './groupSuggestions'
import type { Suggestion } from '@/hooks/useActiveSuggestions'

it('keeps each category reachable before expanding a long category', () => {
    const files: Suggestion[] = Array.from({ length: 8 }, (_, index) => ({ key: `file-${index}`, text: `file-${index}`, label: `file-${index}`, group: 'files' }))
    const folder: Suggestion = { key: 'folder', text: 'folder', label: 'folder', group: 'folders' }
    const collapsed = groupSuggestions([...files, folder], new Set())
    expect(collapsed.map(suggestion => suggestion.key)).toEqual(['file-0', 'file-1', 'file-2', 'suggestions:expand:files', 'folder'])
    expect(collapsed[3].expandGroup).toEqual({ group: 'files', remaining: 5 })
    expect(groupSuggestions([...files, folder], new Set(['files']))).toEqual([...files, folder])
})
