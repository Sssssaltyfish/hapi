import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { groupSuggestions } from '@/utils/groupSuggestions'

export type SuggestionGroup = 'threads' | 'files' | 'folders' | 'skills' | 'apps' | 'plugins'

export interface Suggestion {
    key: string
    text: string
    label: string
    description?: string
    content?: string  // Expanded content for Codex user prompts
    source?: 'builtin' | 'user' | 'plugin' | 'project'
    group?: SuggestionGroup
    /** A navigation row in the picker, never inserted into composer text. */
    expandGroup?: { group: SuggestionGroup; remaining: number }
    /** When set, rich composer inserts an inline session atom instead of `text`. */
    sessionMention?: { id: string; title: string }
    /** Native commands share the normal composer submit path when selected. */
    submitOnSelect?: boolean
}

type SuggestionHandler = (query: string) => Promise<Suggestion[]>

interface SuggestionInput {
    query: string | null
    handler: SuggestionHandler
    clampSelection: boolean
    autoSelectFirst: boolean
    allowEmptyQuery: boolean
    version: number
}

interface SuggestionOptions {
    clampSelection?: boolean   // Legacy option; matching suggestion keys are always preserved before clamping
    autoSelectFirst?: boolean  // If true, automatically select first item when suggestions appear
    wrapAround?: boolean       // If true, wrap around when reaching top/bottom
    allowEmptyQuery?: boolean  // If true, allow empty string queries
}

/**
 * A simple value sync class that processes the latest value
 * Ensures only the most recent query is processed
 */
class ValueSync<T> {
    private latestValue: T | undefined
    private hasValue = false
    private processing = false
    private stopped = false
    private command: (value: T) => Promise<void>

    constructor(command: (value: T) => Promise<void>) {
        this.command = command
    }

    setValue(value: T) {
        if (this.stopped) {
            // Reset stopped state - this handles React Strict Mode re-mounting
            this.stopped = false
        }
        this.latestValue = value
        this.hasValue = true
        if (!this.processing) {
            this.processing = true
            this.doSync()
        }
    }

    stop() {
        this.stopped = true
    }

    private async doSync() {
        while (this.hasValue && !this.stopped) {
            const value = this.latestValue!
            this.hasValue = false
            try {
                await this.command(value)
            } catch (e) {
                console.error('ValueSync error:', e)
            }
        }
        this.processing = false
    }
}

interface SuggestionRequest {
    input: SuggestionInput
    generation: number
}

/**
 * Hook that manages autocomplete suggestions based on an active word query
 * Returns: [suggestions, selectedIndex, moveUp, moveDown]
 */
export function useActiveSuggestions(
    query: string | null,
    handler: SuggestionHandler,
    options: SuggestionOptions = {}
) {
    const {
        clampSelection = true,
        autoSelectFirst = true,
        wrapAround = true,
        allowEmptyQuery = false
    } = options

    const latestInputRef = useRef<SuggestionInput>({
        query,
        handler,
        clampSelection,
        autoSelectFirst,
        allowEmptyQuery,
        version: 0,
    })
    const expandedGroups = useRef(new Set<SuggestionGroup>())

    // Commit the active input before passive request effects or any settled promise
    // can publish. A layout effect avoids leaking an abandoned concurrent render.
    useLayoutEffect(() => {
        const latestInput = latestInputRef.current
        if (
            latestInput.query !== query
            || latestInput.handler !== handler
            || latestInput.clampSelection !== clampSelection
            || latestInput.autoSelectFirst !== autoSelectFirst
            || latestInput.allowEmptyQuery !== allowEmptyQuery
        ) {
            if (latestInput.query !== query || latestInput.handler !== handler) expandedGroups.current.clear()
            latestInputRef.current = {
                query,
                handler,
                clampSelection,
                autoSelectFirst,
                allowEmptyQuery,
                version: latestInput.version + 1,
            }
        }
    }, [query, handler, clampSelection, autoSelectFirst, allowEmptyQuery])

    // State for suggestions
    const [state, setState] = useState<{
        suggestions: Suggestion[]
        allSuggestions: Suggestion[]
        selected: number
        input: SuggestionInput | null
    }>({
        suggestions: [],
        allSuggestions: [],
        selected: -1,
        input: null
    })

    const moveUp = useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev

            if (prev.selected <= 0) {
                // At top or nothing selected
                if (wrapAround) {
                    return { ...prev, selected: prev.suggestions.length - 1 }
                } else {
                    return { ...prev, selected: 0 }
                }
            }
            // Move up
            return { ...prev, selected: prev.selected - 1 }
        })
    }, [wrapAround])

    const moveDown = useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev

            if (prev.selected >= prev.suggestions.length - 1) {
                // At bottom
                if (wrapAround) {
                    return { ...prev, selected: 0 }
                } else {
                    return { ...prev, selected: prev.suggestions.length - 1 }
                }
            }
            // If nothing selected, select first
            if (prev.selected < 0) {
                return { ...prev, selected: 0 }
            }
            // Move down
            return { ...prev, selected: prev.selected + 1 }
        })
    }, [wrapAround])

    const clear = useCallback(() => {
        expandedGroups.current.clear()
        setState({ suggestions: [], allSuggestions: [], selected: -1, input: null })
    }, [])

    const expandGroup = useCallback((group: SuggestionGroup) => {
        expandedGroups.current.add(group)
        setState(previous => ({
            ...previous,
            suggestions: groupSuggestions(previous.allSuggestions, expandedGroups.current),
        }))
    }, [])

    const syncRef = useRef<ValueSync<SuggestionRequest> | null>(null)
    const generationRef = useRef(0)

    useEffect(() => {
        const sync = new ValueSync<SuggestionRequest>(async ({ input, generation }) => {
            const { query: nextQuery, handler: requestHandler } = input
            if (nextQuery === null || (!allowEmptyQuery && nextQuery === '')) return

            const allSuggestions = await requestHandler(nextQuery)

            const isCurrentRequest = () => {
                const latest = latestInputRef.current
                return generation === generationRef.current
                    && input.version === latest.version
                    && nextQuery === latest.query
            }

            // ValueSync serializes work, but a previous request can still finish after a
            // newer query has been queued. Only the current query generation may publish.
            if (!isCurrentRequest()) return

            setState((prev) => {
                // React may defer this updater until another query is current.
                if (!isCurrentRequest()) return prev
                const suggestions = groupSuggestions(allSuggestions, expandedGroups.current)

                if (prev.selected >= 0 && prev.selected < prev.suggestions.length) {
                    const previousKey = prev.suggestions[prev.selected].key
                    const newIndex = suggestions.findIndex(s => s.key === previousKey)
                    if (newIndex !== -1) {
                        // Preserve the user's logical selection across a refreshed or reordered list.
                        return { suggestions, allSuggestions, selected: newIndex, input }
                    }
                }

                // The selected key disappeared (or there was no selection): retain the
                // existing fallback semantics and clamp the index to the new list.
                const clampedSelection = Math.min(prev.selected, suggestions.length - 1)
                return {
                    suggestions,
                    allSuggestions,
                    selected: clampedSelection < 0 && suggestions.length > 0 && autoSelectFirst ? 0 : clampedSelection,
                    input
                }
            })
        })

        syncRef.current = sync

        return () => {
            sync.stop()
            generationRef.current += 1
            if (syncRef.current === sync) {
                syncRef.current = null
            }
        }
    }, [clampSelection, autoSelectFirst, allowEmptyQuery])

    useEffect(() => {
        const generation = ++generationRef.current
        const latestInput = latestInputRef.current
        syncRef.current?.setValue({
            input: latestInput,
            generation,
        })
    }, [query, handler, clampSelection, autoSelectFirst, allowEmptyQuery])

    const latestInput = latestInputRef.current
    const currentInputVersion = latestInput.query === query
        && latestInput.handler === handler
        && latestInput.clampSelection === clampSelection
        && latestInput.autoSelectFirst === autoSelectFirst
        && latestInput.allowEmptyQuery === allowEmptyQuery
        ? latestInput.version
        : latestInput.version + 1

    const stateMatchesInput = state.input !== null
        && state.input.query === query
        && state.input.handler === handler
        && state.input.clampSelection === clampSelection
        && state.input.autoSelectFirst === autoSelectFirst
        && state.input.allowEmptyQuery === allowEmptyQuery
        && state.input.version === currentInputVersion

    // Hide published suggestions as soon as a new input renders. Keep the old state
    // internally so the replacement result can still preserve selection by key.
    if (query === null || (!allowEmptyQuery && query === '') || !stateMatchesInput) {
        return [[], -1, moveUp, moveDown, clear, expandGroup] as const
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown, clear, expandGroup] as const
}
