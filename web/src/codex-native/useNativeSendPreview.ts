import { startTransition, useLayoutEffect, useRef, useState } from 'react'
import type { DecryptedMessage } from '@/types/api'
import type { NativeItemEntry, NativeRecord } from './types'

/** Only the current submission is local. History and queue snapshots stay daemon-owned. */
export function useNativeSendPreview(items: NativeItemEntry[], queue: NativeRecord[]) {
    const [preview, setPreview] = useState<DecryptedMessage | null>(null)
    const flight = useRef<{ id: string; observed: boolean } | null>(null)
    const id = preview?.id
    const observed = id !== undefined && (
        queue.some(item => item.clientUserMessageId === id) ||
        items.some(({ item }) => (item.type === 'userMessage' ||
            (item.type === 'steeringUserMessage' && item.status === 'accepted')) &&
            (item.clientId === id || item.id === id))
    )
    // SSE can confirm the submission before the HTTP response, or even if that response is lost.
    useLayoutEffect(() => {
        if (!observed) return
        const current = flight.current
        if (current && current.id === id) current.observed = true
        setPreview(null)
    }, [id, observed])
    return {
        message: observed ? null : preview,
        begin(message: DecryptedMessage) {
            if (flight.current) return false
            flight.current = { id: message.id, observed: false }
            setPreview(message)
            return true
        },
        confirmed(id: string) { return flight.current?.id === id && flight.current.observed },
        finish(id: string) { if (flight.current?.id === id) flight.current = null },
        reject(id: string) { setPreview(row => row?.id === id ? null : row) },
        accept(id: string, refresh: Promise<unknown>) {
            // Bridge the ACK -> snapshot interval. This preview isn't a runner queue entry.
            setPreview(row => row?.id === id ? { ...row, status: 'sent', invokedAt: undefined } : row)
            void refresh.finally(() => startTransition(() => {
                setPreview(row => row?.id === id ? null : row)
            }))
        },
    }
}
