import { useCallback, useSyncExternalStore } from 'react'
import type { MessageDeliveryMode } from '@hapi/protocol'

const KEY = 'hapi-composer-send-mode'
const listeners = new Set<() => void>()
function read(): MessageDeliveryMode {
    try { return localStorage.getItem(KEY) === 'steer' ? 'steer' : 'queue' } catch { return 'queue' }
}
function subscribe(listener: () => void) {
    listeners.add(listener)
    const storage = (event: StorageEvent) => { if (event.key === KEY) listener() }
    window.addEventListener('storage', storage)
    return () => { listeners.delete(listener); window.removeEventListener('storage', storage) }
}
export function useComposerSendMode() {
    const composerSendMode = useSyncExternalStore(subscribe, read, () => 'queue' as const)
    const setComposerSendMode = useCallback((mode: MessageDeliveryMode) => {
        try { if (mode === 'queue') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode) } catch { return }
        for (const listener of listeners) listener()
    }, [])
    return { composerSendMode, setComposerSendMode }
}
