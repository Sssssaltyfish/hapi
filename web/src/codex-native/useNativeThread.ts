import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { NativeEvent, NativeItemEntry, NativePage, NativeRecord, NativeRequest } from './types'
import { mergeNativeItems, record } from './presentation'
import { clearConversationReadingPosition } from '@/lib/conversation-reading-position'

type NativeWindowSnapshot = { items: NativeItemEntry[]; cursor: string | null; newerCursor: string | null; hasNewer: boolean; browsingOlder: boolean; savedAt: number }
const windowCache = new Map<string, NativeWindowSnapshot>()
const MAX_CACHED_WINDOWS = 12
const WINDOW_TTL_MS = 30 * 60 * 1000

function readCachedWindow(key?: string): NativeWindowSnapshot | null {
    if (!key) return null
    const cached = windowCache.get(key)
    if (cached && Date.now() - cached.savedAt <= WINDOW_TTL_MS) return cached
    windowCache.delete(key)
    return null
}

export function useNativeThread(api: ApiClient, id: string, enabled = true, cacheKey?: string, preserveHistory = false) {
    const cached = useRef(readCachedWindow(cacheKey))
    const [detail, setDetail] = useState<NativeRecord>({})
    const [items, setItems] = useState<NativeItemEntry[]>(() => {
        if (cacheKey && preserveHistory && !cached.current) clearConversationReadingPosition(cacheKey)
        return cached.current?.items ?? []
    })
    const itemsRef = useRef(items)
    itemsRef.current = items
    const [cursor, setCursor] = useState<string | null>(cached.current?.cursor ?? null)
    const [newerCursor, setNewerCursor] = useState<string | null>(cached.current?.newerCursor ?? null)
    const [loading, setLoading] = useState(true)
    const [olderLoading, setOlderLoading] = useState(false)
    const [error, setError] = useState('')
    const [connected, setConnected] = useState(false)
    const [requests, setRequests] = useState<NativeRequest[]>([])
    const eventListeners = useRef(new Set<(event: NativeEvent) => void>())
    const subscribeEvents = useCallback((listener: (event: NativeEvent) => void) => {
        eventListeners.current.add(listener)
        return () => { eventListeners.current.delete(listener) }
    }, [])
    const [hasNewer, setHasNewer] = useState(Boolean(cached.current && preserveHistory && (cached.current.hasNewer ?? true)))
    const browsingOlder = useRef(Boolean(cached.current && preserveHistory))
    const historyGeneration = useRef(0)
    const olderRequest = useRef<symbol | null>(null)
    const olderPreviousBrowsing = useRef<boolean | null>(null)
    const alive = useRef(true)
    const refreshing = useRef<symbol | null>(null)
    useEffect(() => {
        if (!cacheKey || items.length === 0) return
        windowCache.delete(cacheKey)
        windowCache.set(cacheKey, { items: items.slice(0, 300), cursor, newerCursor, hasNewer, browsingOlder: browsingOlder.current, savedAt: Date.now() })
        while (windowCache.size > MAX_CACHED_WINDOWS) windowCache.delete(windowCache.keys().next().value!)
    }, [cacheKey, items, cursor, newerCursor, hasNewer])
    const applySettings = useCallback((settings: NativeRecord) => {
        // This is a confirmed daemon response, also used when SSE is reconnecting.
        setDetail(current => ({ ...current, threadSettings: settings }))
    }, [])

    const refreshDetail = useCallback(async () => {
        const response = await api.getCodexNativeThread(id)
        if (alive.current) setDetail(current => ({ ...current, ...response }))
    }, [api, id])

    const refreshActiveTurn = useCallback(async () => {
        const response = await api.getCodexNativeActiveTurn(id)
        if (alive.current) setDetail(current => ({ ...current, activeTurn: response.activeTurn }))
    }, [api, id])

    const latest = useCallback(async (reset = false) => {
        if (refreshing.current && !reset) return
        if (reset) {
            // Return to latest replaces the history window. An older page may
            // still arrive, but no longer owns this window or its loading state.
            historyGeneration.current += 1
            olderRequest.current = null
            olderPreviousBrowsing.current = null
            browsingOlder.current = false
            setOlderLoading(false)
            setLoading(true)
        }
        const generation = historyGeneration.current
        const request = Symbol('latest-page')
        refreshing.current = request
        const isCurrent = () => alive.current && generation === historyGeneration.current && refreshing.current === request
        try {
            const page = await api.getCodexNativeItems(id)
            if (!isCurrent()) return
            if (reset) {
                browsingOlder.current = false
                setHasNewer(false)
                setItems([...page.data].reverse())
                setCursor(page.nextCursor)
                setNewerCursor(page.backwardsCursor ?? null)
            } else if (browsingOlder.current) {
                if (page.data[0]?.item.id !== itemsRef.current.at(-1)?.item.id) setHasNewer(true)
            } else {
                setItems([...page.data].reverse())
                setCursor(page.nextCursor)
                setNewerCursor(page.backwardsCursor ?? null)
            }
            setError('')
        } catch (error) {
            if (isCurrent()) setError(String(error))
        } finally {
            if (isCurrent()) {
                refreshing.current = null
                setLoading(false)
            }
        }
    }, [api, id])

    const readHistory = useCallback(async (direction: 'older' | 'newer', beforeApply?: (entries: NativeItemEntry[]) => boolean) => {
        const initialCursor = direction === 'older' ? cursor : newerCursor
        if (!initialCursor || olderRequest.current) return null
        const generation = historyGeneration.current
        const request = Symbol(`${direction}-page`)
        olderRequest.current = request
        const isCurrent = () => alive.current && generation === historyGeneration.current && olderRequest.current === request
        const wasBrowsingOlder = browsingOlder.current
        olderPreviousBrowsing.current = wasBrowsingOlder
        browsingOlder.current = true
        setOlderLoading(true)
        try {
            const currentItems = itemsRef.current
            const known = new Set(currentItems.map(entry => entry.item.id))
            let pageCursor: string | null = initialCursor
            let lastRequestedCursor = initialCursor
            let oppositeCursor: string | null = null
            let nextItems = currentItems
            for (let pages = 0; pages < 8 && pageCursor; pages++) {
                lastRequestedCursor = pageCursor
                const page: NativePage<NativeItemEntry> = direction === 'older'
                    ? await api.getCodexNativeItems(id, pageCursor)
                    : await api.getCodexNativeItems(id, pageCursor, 'asc')
                if (!isCurrent()) return null
                if (page.nextCursor === pageCursor) throw new Error('Native history cursor did not advance')
                const incoming = direction === 'older' ? [...page.data].reverse() : page.data
                const added = incoming.some(entry => !known.has(entry.item.id))
                if (added) nextItems = mergeNativeItems(nextItems, incoming, direction === 'older' ? 'older' : 'latest')
                else {
                    const updates = new Map(incoming.map(entry => [entry.item.id, entry]))
                    nextItems = nextItems.map(entry => updates.get(entry.item.id) ?? entry)
                }
                pageCursor = page.nextCursor
                oppositeCursor = page.backwardsCursor ?? null
                // A reverse cursor may overlap the retained window. Advance
                // through that overlap without exposing empty paging steps.
                if (added) break
            }
            const accepted = beforeApply ? beforeApply(nextItems) : true
            if (!isCurrent()) return null
            if (!accepted) { browsingOlder.current = wasBrowsingOlder; return null }
            setItems(nextItems)
            if (direction === 'older') {
                setCursor(pageCursor)
                const previousEnd = currentItems.at(-1)?.item.id
                if (previousEnd && !nextItems.some(entry => entry.item.id === previousEnd)) {
                    setNewerCursor(oppositeCursor)
                    setHasNewer(Boolean(oppositeCursor))
                }
            } else {
                // Keep the server-issued end cursor reusable if new messages
                // arrive while this reader remains in history mode.
                setNewerCursor(pageCursor ?? lastRequestedCursor)
                setHasNewer(Boolean(pageCursor))
                const previousStart = currentItems[0]?.item.id
                if (previousStart && !nextItems.some(entry => entry.item.id === previousStart)) setCursor(oppositeCursor)
            }
            setError('')
            return { items: nextItems, nextCursor: pageCursor }
        } catch (error) {
            if (isCurrent()) {
                browsingOlder.current = wasBrowsingOlder
                setError(String(error))
            }
            return null
        } finally {
            if (isCurrent()) {
                olderRequest.current = null
                olderPreviousBrowsing.current = null
                setOlderLoading(false)
            }
        }
    }, [api, id, cursor, newerCursor])
    const older = useCallback((beforeApply?: (entries: NativeItemEntry[]) => boolean) => readHistory('older', beforeApply), [readHistory])
    const newer = useCallback((beforeApply?: (entries: NativeItemEntry[]) => boolean) => readHistory('newer', beforeApply), [readHistory])

    const seek = useCallback(async (pageCursor: string | null, accepts: (entries: NativeItemEntry[]) => boolean) => {
        historyGeneration.current += 1
        olderRequest.current = null
        olderPreviousBrowsing.current = null
        refreshing.current = null
        const generation = historyGeneration.current
        const request = Symbol('seek-page')
        olderRequest.current = request
        const isCurrent = () => alive.current && generation === historyGeneration.current && olderRequest.current === request
        setOlderLoading(true)
        setLoading(false)
        try {
            const page = await api.getCodexNativeItems(id, pageCursor ?? undefined)
            if (!isCurrent()) return false
            const entries = [...page.data].reverse().slice(0, 300)
            if (!accepts(entries)) return false
            browsingOlder.current = true
            setItems(entries)
            setCursor(page.nextCursor)
            setNewerCursor(page.backwardsCursor ?? null)
            setHasNewer(Boolean(page.backwardsCursor))
            setError('')
            return true
        } finally {
            if (isCurrent()) { olderRequest.current = null; setOlderLoading(false) }
        }
    }, [api, id])

    const cancelOlder = useCallback(() => {
        if (!olderRequest.current) return
        if (olderPreviousBrowsing.current !== null) browsingOlder.current = olderPreviousBrowsing.current
        olderPreviousBrowsing.current = null
        historyGeneration.current += 1
        olderRequest.current = null
        refreshing.current = null
        setOlderLoading(false)
        setLoading(false)
    }, [])
    const browseHistory = useCallback(() => { browsingOlder.current = true }, [])

    useEffect(() => {
        if (!enabled) { setLoading(false); return }
        alive.current = true
        void refreshDetail().catch(error => setError(String(error)))
        void refreshActiveTurn().catch(error => setError(String(error)))
        void latest(!(cached.current && preserveHistory))
        const controller = new AbortController()
        let retry: ReturnType<typeof setTimeout> | undefined
        let refreshTimer: ReturnType<typeof setTimeout> | undefined
        const invalidate = () => {
            if (refreshTimer) return
            refreshTimer = setTimeout(() => {
                refreshTimer = undefined
                void refreshDetail().catch(error => { if (alive.current) setError(String(error)) })
                void refreshActiveTurn().catch(error => { if (alive.current) setError(String(error)) })
                void latest()
            }, 750)
        }
        const onEvent = (event: NativeEvent) => {
            if (!alive.current) return
            for (const listener of eventListeners.current) listener(event)
            if (event.method === 'hapi/heartbeat') return
            if (event.method === 'hapi/ready') {
                setConnected(true)
                if (event.params.thread) setDetail(current => ({ ...current, ...event.params }))
                if (Array.isArray(event.params.requests)) setRequests((event.params.requests as NativeRequest[]).map(request => ({ ...request, receivedAt: Date.now() })))
                invalidate()
                return
            }
            if (event.method === 'thread/settings/updated') {
                setDetail(current => ({ ...current, threadSettings: event.params.threadSettings ?? event.params.settings ?? event.params }))
                return
            }
            if (event.method === 'thread/status/changed') {
                setDetail(current => ({ ...current, thread: { ...record(current.thread), status: event.params.status } }))
                return
            }
            if (event.method === 'turn/started') {
                setDetail(current => ({ ...current, activeTurn: event.params.turn, thread: { ...record(current.thread), status: { type: 'active' } } }))
            }
            if (event.method === 'turn/completed') {
                setDetail(current => ({ ...current, activeTurn: null, thread: { ...record(current.thread), status: { type: 'idle' } } }))
            }
            if (event.method === 'hapi/request') {
                const request = { ...event.params, receivedAt: Date.now() } as unknown as NativeRequest
                setRequests(current => [...current.filter(value => value.id !== request.id), request])
                return
            }
            if (event.method === 'hapi/requestResolved') {
                setRequests(current => current.filter(value => value.id !== event.params.id))
                return
            }
            if (event.method === 'item/agentMessage/delta') {
                const itemId = event.params.itemId
                const delta = event.params.delta
                if (typeof itemId === 'string' && typeof delta === 'string' && !browsingOlder.current) {
                    setItems(current => current.map(entry => entry.item.id === itemId
                        ? { ...entry, item: { ...entry.item, text: String(entry.item.text ?? '') + delta } } : entry))
                }
            }
            const nativeItem = record(event.params.item)
            if (typeof nativeItem.id === 'string' && typeof nativeItem.type === 'string' && !browsingOlder.current) {
                const entry: NativeItemEntry = {
                    ...event.params,
                    observedAtMs: Date.now(),
                    item: nativeItem as NativeItemEntry['item'],
                    turnId: typeof event.params.turnId === 'string' ? event.params.turnId : undefined,
                }
                setItems(current => mergeNativeItems(current, [entry], 'latest'))
            }
            if (event.method.includes('request') || event.method.includes('approval')) invalidate()
            else if (!event.method.endsWith('/delta')) invalidate()
        }
        const connect = () => {
            void api.streamCodexNativeEvents(id, controller.signal, onEvent).catch(error => {
                if (!controller.signal.aborted) setError(String(error))
            }).finally(() => {
                if (controller.signal.aborted) return
                setConnected(false)
                retry = setTimeout(connect, 2000)
            })
        }
        connect()
        return () => {
            alive.current = false
            historyGeneration.current += 1
            olderRequest.current = null
            refreshing.current = null
            controller.abort()
            clearTimeout(retry)
            clearTimeout(refreshTimer)
        }
    }, [api, id, enabled, latest, refreshDetail, refreshActiveTurn])

    return { detail, items, cursor, newerCursor, loading, olderLoading, error, connected, requests, setRequests, hasNewer, older, newer, seek, cancelOlder, browseHistory, latest, refreshDetail, applySettings, subscribeEvents }
}
