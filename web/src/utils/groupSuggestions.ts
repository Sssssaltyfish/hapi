import type { Suggestion, SuggestionGroup } from '@/hooks/useActiveSuggestions'

export const SUGGESTION_GROUP_ORDER: readonly SuggestionGroup[] = ['threads', 'files', 'folders', 'skills', 'apps', 'plugins']
export const INITIAL_SUGGESTIONS_PER_GROUP = 3

/** Expansion rows participate in the same keyboard selection list as suggestions. */
export function groupSuggestions(suggestions: readonly Suggestion[], expanded: ReadonlySet<SuggestionGroup>): Suggestion[] {
    if (!suggestions.some(suggestion => suggestion.group)) return [...suggestions]
    const result = suggestions.filter(suggestion => !suggestion.group)
    for (const group of SUGGESTION_GROUP_ORDER) {
        const entries = suggestions.filter(suggestion => suggestion.group === group)
        const visible = expanded.has(group) ? entries : entries.slice(0, INITIAL_SUGGESTIONS_PER_GROUP)
        result.push(...visible)
        if (visible.length < entries.length) result.push({
            key: `suggestions:expand:${group}`,
            text: '', label: '', group,
            expandGroup: { group, remaining: entries.length - visible.length },
        })
    }
    return result
}
