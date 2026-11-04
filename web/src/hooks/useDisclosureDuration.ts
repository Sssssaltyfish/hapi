import { useSyncExternalStore } from 'react'

export const DISCLOSURE_DURATIONS = [0, 80, 150, 250] as const
type DisclosureDuration = typeof DISCLOSURE_DURATIONS[number]

const DEFAULT_DURATION: DisclosureDuration = 150
const STORAGE_KEY = 'hapi-disclosure-duration'
const listeners = new Set<() => void>()
let currentDuration: DisclosureDuration = DEFAULT_DURATION

function applyDuration(duration: DisclosureDuration) {
    document.documentElement.style.setProperty('--app-disclosure-duration', `${duration}ms`)
    if (duration === currentDuration) return
    currentDuration = duration
    for (const listener of listeners) listener()
}

function restoreDuration() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY)
        applyDuration(DISCLOSURE_DURATIONS.find(duration => String(duration) === saved) ?? DEFAULT_DURATION)
    } catch {
        applyDuration(currentDuration)
    }
}

function handleStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY || event.key === null) restoreDuration()
}

export function initializeDisclosureDuration() {
    restoreDuration()
    window.addEventListener('storage', handleStorage)
}

export function setDisclosureDuration(duration: DisclosureDuration) {
    applyDuration(duration)
    try {
        if (duration === DEFAULT_DURATION) localStorage.removeItem(STORAGE_KEY)
        else localStorage.setItem(STORAGE_KEY, String(duration))
    } catch {
        // The choice still applies in this tab when storage is unavailable.
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function useDisclosureDuration() {
    return useSyncExternalStore(subscribe, () => currentDuration, () => DEFAULT_DURATION)
}
