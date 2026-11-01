import { Fragment, memo, useEffect, useRef } from 'react'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { useTranslation } from '@/lib/use-translation'

interface AutocompleteProps {
    suggestions: readonly Suggestion[]
    selectedIndex: number
    onSelect: (index: number) => void
}

/**
 * Autocomplete suggestions list component
 */
export const Autocomplete = memo(function Autocomplete(props: AutocompleteProps) {
    const { suggestions, selectedIndex, onSelect } = props
    const { t } = useTranslation()
    const listRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (selectedIndex < 0 || selectedIndex >= suggestions.length) return
        const listEl = listRef.current
        if (!listEl) return
        const selectedEl = listEl.querySelector<HTMLButtonElement>(
            `[data-suggestion-index="${selectedIndex}"]`
        )
        selectedEl?.scrollIntoView({ block: 'nearest' })
    }, [selectedIndex, suggestions.length])

    if (suggestions.length === 0) {
        return null
    }

    return (
        <div ref={listRef} role="listbox" aria-label={t('suggestions.title')}>
            {suggestions.map((suggestion, index) => (
                <Fragment key={suggestion.key}>
                {suggestion.group && suggestions[index - 1]?.group !== suggestion.group ? (
                    <div className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--app-hint)]">
                        {t(`suggestions.group.${suggestion.group}`)}
                    </div>
                ) : null}
                <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    title={suggestion.label ? [suggestion.label, suggestion.description].filter(Boolean).join('\n') : undefined}
                    data-suggestion-index={index}
                    className={`flex w-full min-w-0 cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors ${
                        index === selectedIndex
                            ? 'bg-[var(--app-button)] text-[var(--app-button-text)]'
                            : 'text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]'
                    }`}
                    onClick={() => onSelect(index)}
                    onMouseDown={(e) => e.preventDefault()} // Prevent blur on textarea
                >
                    <span className="block w-full min-w-0 truncate font-medium">{suggestion.expandGroup
                        ? t('suggestions.showMore', { count: suggestion.expandGroup.remaining })
                        : suggestion.label}</span>
                    {suggestion.description && (
                        <span className={`w-full min-w-0 text-xs leading-snug ${suggestion.group === 'threads' ? 'truncate' : 'min-h-[2.25rem] line-clamp-2'} ${
                            index === selectedIndex
                                ? 'opacity-80'
                                : 'text-[var(--app-hint)]'
                        }`}>
                            {suggestion.description}
                        </span>
                    )}
                </button>
                </Fragment>
            ))}
        </div>
    )
})
