export function matchesModelFilter(id: string | null | undefined, label: string | undefined, patterns?: readonly string[]): boolean {
    if (!id || id === 'auto' || id === 'default' || !patterns?.length) return true
    return patterns.some(pattern => {
        const value = pattern.trim()
        if (!value) return true
        const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
        const matcher = new RegExp(value.includes('*') ? `^${escaped}$` : escaped, 'i')
        return matcher.test(id) || (label !== undefined && matcher.test(label))
    })
}

/** Keep an existing selection visible without silently changing the session. */
export function filterModelOptions<T extends { value: string | null; label: string }>(
    options: T[], patterns?: readonly string[], selected?: string | null,
): T[] {
    if (!patterns?.length) return options
    return options.filter(option => option.value === selected || matchesModelFilter(option.value, option.label, patterns))
}
