import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-session-list-agent-label'
const sameTabListeners = new Set<(value: boolean) => void>()

function readPreference(): boolean {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true' } catch { return false }
}

export function useSessionListAgentLabel() {
    const [showSessionListAgentLabel, setValue] = useState(readPreference)
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) setValue(event.newValue === 'true')
        }
        sameTabListeners.add(setValue)
        window.addEventListener('storage', onStorage)
        return () => {
            sameTabListeners.delete(setValue)
            window.removeEventListener('storage', onStorage)
        }
    }, [])
    const setShowSessionListAgentLabel = useCallback((value: boolean) => {
        try {
            if (value) localStorage.setItem(STORAGE_KEY, 'true')
            else localStorage.removeItem(STORAGE_KEY)
        } catch { /* Keep the current view usable when storage is unavailable. */ }
        for (const listener of sameTabListeners) listener(value)
    }, [])
    return { showSessionListAgentLabel, setShowSessionListAgentLabel }
}
