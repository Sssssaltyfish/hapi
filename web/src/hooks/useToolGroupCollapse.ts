import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_TOOL_GROUPS_COLLAPSED = true

// Keep existing user choices under their original storage key.
const TOOL_GROUPS_COLLAPSED_STORAGE_KEY = 'hapi-codex-exploration-collapsed'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(TOOL_GROUPS_COLLAPSED_STORAGE_KEY)
    } catch {
        return null
    }
}

function safeSetItem(value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(TOOL_GROUPS_COLLAPSED_STORAGE_KEY, value)
    } catch {
        // Ignore storage errors.
    }
}

function safeRemoveItem(): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(TOOL_GROUPS_COLLAPSED_STORAGE_KEY)
    } catch {
        // Ignore storage errors.
    }
}

function parseToolGroupsCollapsed(raw: string | null): boolean {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return DEFAULT_TOOL_GROUPS_COLLAPSED
}

export function getInitialToolGroupsCollapsed(): boolean {
    return parseToolGroupsCollapsed(safeGetItem())
}

export function useToolGroupCollapse(): {
    toolGroupsCollapsed: boolean
    setToolGroupsCollapsed: (value: boolean) => void
} {
    const [toolGroupsCollapsed, setToolGroupsCollapsedState] = useState<boolean>(getInitialToolGroupsCollapsed)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== TOOL_GROUPS_COLLAPSED_STORAGE_KEY) return
            setToolGroupsCollapsedState(parseToolGroupsCollapsed(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setToolGroupsCollapsed = useCallback((value: boolean) => {
        setToolGroupsCollapsedState(value)
        if (value === DEFAULT_TOOL_GROUPS_COLLAPSED) {
            safeRemoveItem()
        } else {
            safeSetItem(String(value))
        }
    }, [])

    return { toolGroupsCollapsed, setToolGroupsCollapsed }
}
