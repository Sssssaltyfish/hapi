import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_LONG_PASTE_THRESHOLD = 2000
const storageKey = 'hapi-long-paste-attachment'
const changeEvent = 'hapi-long-paste-attachment-changed'
type Preference = { enabled: boolean; threshold: number }

function readPreference(): Preference {
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
        return { enabled: stored?.enabled === true, threshold: normalizeThreshold(stored?.threshold) }
    } catch {
        return { enabled: false, threshold: DEFAULT_LONG_PASTE_THRESHOLD }
    }
}

function normalizeThreshold(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : DEFAULT_LONG_PASTE_THRESHOLD
}

export function useLongPasteAttachment() {
    const [preference, setPreference] = useState(readPreference)
    useEffect(() => {
        const update = () => setPreference(readPreference())
        window.addEventListener('storage', update)
        window.addEventListener(changeEvent, update)
        return () => {
            window.removeEventListener('storage', update)
            window.removeEventListener(changeEvent, update)
        }
    }, [])
    const update = useCallback((patch: Partial<Preference>) => {
        const next = { ...readPreference(), ...patch }
        next.threshold = normalizeThreshold(next.threshold)
        setPreference(next)
        try {
            localStorage.setItem(storageKey, JSON.stringify(next))
            window.dispatchEvent(new Event(changeEvent))
        } catch { /* Keep the setting for this view. */ }
    }, [])
    return {
        ...preference,
        setEnabled: (enabled: boolean) => update({ enabled }),
        setThreshold: (threshold: number) => update({ threshold }),
    }
}
