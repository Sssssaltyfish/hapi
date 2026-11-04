import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { NativeEvent, NativeRecord } from './types'

/** A refreshed view of the daemon queue, with no local pending-message ledger. */
export function useNativeQueue(api: ApiClient, id: string, enabled: boolean,
    subscribe: (listener: (event: NativeEvent) => void) => () => void) {
    const [items, setItems] = useState<NativeRecord[]>([])
    const [error, setError] = useState('')
    const refreshRef = useRef<() => Promise<void>>(async () => {})
    const refresh = useCallback(() => refreshRef.current(), [])
    useEffect(() => {
        let disposed = false
        let revision = 0
        let pending: Promise<void> | null = null
        const load = (): Promise<void> => {
            revision++
            if (pending) return pending
            pending = (async () => {
                let reading: number
                do {
                    reading = revision
                    try {
                        const next: NativeRecord[] = []
                        const cursors = new Set<string>()
                        let cursor: string | undefined
                        do {
                            const page = await api.getCodexNativeQueue(id, cursor)
                            next.push(...page.data)
                            cursor = page.nextCursor ?? undefined
                            if (cursor && cursors.has(cursor)) throw new Error('Native queue pagination did not advance')
                            if (cursor) cursors.add(cursor)
                        } while (cursor && !disposed)
                        if (!disposed && reading === revision) { setItems(next); setError('') }
                    } catch (error) {
                        if (!disposed && reading === revision) { setItems([]); setError(String(error)) }
                    }
                } while (!disposed && reading !== revision)
            })().finally(() => { pending = null })
            return pending
        }
        refreshRef.current = enabled ? load : async () => {}
        if (!enabled) { setItems([]); setError(''); return }
        const unsubscribe = subscribe(event => {
            if (['hapi/ready', 'thread/queue/changed', 'turn/started', 'turn/completed'].includes(event.method)) void load()
        })
        void load()
        return () => { disposed = true; unsubscribe(); refreshRef.current = async () => {} }
    }, [api, id, enabled, subscribe])
    return { items, error, refresh }
}
