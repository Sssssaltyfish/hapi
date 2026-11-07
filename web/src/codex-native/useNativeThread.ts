import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { NativeEvent, NativeItemEntry, NativePage, NativeRecord, NativeRequest, NativeTurnContextPage } from './types'
import { mergeNativeItems, record } from './presentation'
import { clearConversationReadingPosition } from '@/lib/conversation-reading-position'
import { HistoryPageCache, type HistoryDirection } from '@/lib/history-page-cache'
import { codexContextUsage, type ContextUsage } from '@/lib/contextUsage'
import { nativeReasoningParts, reconcileNativeReasoning } from './nativeReasoning'

type NativeWindowSnapshot = { items: NativeItemEntry[]; cursor: string | null; newerCursor: string | null; hasNewer: boolean; browsingOlder: boolean; savedAt: number; contextUsage?: ContextUsage | null }
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
    const settingsRevision = useRef(0)
    const activeTurnRevision = useRef(0)
    const [contextUsage, setContextUsage] = useState<ContextUsage | null>(cached.current?.contextUsage ?? null)
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
    const [historyResetRevision, setHistoryResetRevision] = useState(0)
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
    const seekController = useRef<AbortController | null>(null)
    const historyPages = useRef(new HistoryPageCache<NativePage<NativeItemEntry>>({ items: 900, bytes: 6 * 1024 * 1024 }))
    const tailRevision = useRef(0)
    const latestTailId = useRef<string | undefined>(undefined)
    const pageTailVersions = useRef(new WeakMap<NativePage<NativeItemEntry>, number>())
    const boundaries = useRef(new Map<string, { older?: string | null; newer?: string | null }>())
    const rememberPage = useCallback((page: NativeTurnContextPage, direction: HistoryDirection) => {
        const first = direction === 'older' ? page.data.at(-1) : page.data[0]
        const last = direction === 'older' ? page.data[0] : page.data.at(-1)
        const remember = (entry: NativeItemEntry | undefined, side: HistoryDirection, value: string | null | undefined) => {
            if (!entry || value === undefined) return
            const id = entry.item.id
            boundaries.current.set(id, { ...boundaries.current.get(id), [side]: value })
        }
        remember(first, 'older', direction === 'older' ? page.nextCursor : page.backwardsCursor)
        remember(last, 'newer', direction === 'newer' ? page.nextCursor ?? undefined : page.backwardsCursor ?? page.newerResumeCursor)
        while (boundaries.current.size > 128) boundaries.current.delete(boundaries.current.keys().next().value!)
    }, [])
    const readPage = useCallback(async (direction: HistoryDirection, pageCursor: string) => {
        const generation = historyGeneration.current
        const version = tailRevision.current
        const page = await historyPages.current.read(JSON.stringify([api.getConversationCacheScope?.().key, id, direction, pageCursor, 50]),
            signal => api.getCodexNativeItems(id, pageCursor, direction === 'older' ? 'desc' : 'asc', signal).then(page => {
                pageTailVersions.current.set(page, version)
                return page
            }),
            page => page.data.length,
            () => true,
            // Completed neighbor pages remain reusable while new live items
            // invalidate only cached responses that reached the moving end.
            page => direction === 'older' || page.nextCursor !== null || pageTailVersions.current.get(page) === tailRevision.current)
        if (generation === historyGeneration.current) rememberPage(page, direction)
        return page
    }, [api, id, rememberPage])
    const prefetchFrom = useCallback(async (direction: HistoryDirection, start: string | null, pages = 1) => {
        const generation = historyGeneration.current
        let next = start
        try {
            for (let count = 0; next && count < Math.min(2, pages); count++) {
                const requested = next
                const page = await readPage(direction, requested)
                if (!alive.current || generation !== historyGeneration.current || page.nextCursor === requested) break
                next = page.nextCursor
            }
        } catch { /* Speculation must not change the reader's loading/error state. */ }
    }, [readPage])
    const prefetch = useCallback((direction: HistoryDirection, pages = 1) => prefetchFrom(direction, direction === 'older' ? cursor : newerCursor, pages), [cursor, newerCursor, prefetchFrom])
    useEffect(() => {
        if (!cacheKey || items.length === 0) return
        windowCache.delete(cacheKey)
        // Stream revisions only order events against reads in this hook instance.
        const cachedItems = items.slice(0, 300).map(({ reasoningStreamRevision, reasoningStreamCompleted, ...entry }) => entry)
        windowCache.set(cacheKey, { items: cachedItems, cursor, newerCursor, hasNewer, browsingOlder: browsingOlder.current, savedAt: Date.now(), contextUsage })
        while (windowCache.size > MAX_CACHED_WINDOWS) windowCache.delete(windowCache.keys().next().value!)
    }, [cacheKey, items, cursor, newerCursor, hasNewer, contextUsage])
    const applySettings = useCallback((settings: NativeRecord) => {
        // This is a confirmed daemon response, also used when SSE is reconnecting.
        settingsRevision.current += 1
        setDetail(current => ({ ...current, threadSettings: settings }))
    }, [])

    const refreshDetail = useCallback(async () => {
        const revision = settingsRevision.current
        const response = await api.getCodexNativeThread(id)
        if (alive.current) setDetail(current => ({ ...current, ...response,
            ...(revision !== settingsRevision.current ? { threadSettings: current.threadSettings } : {}) }))
    }, [api, id])

    const refreshActiveTurn = useCallback(async () => {
        const revision = ++activeTurnRevision.current
        const response = await api.getCodexNativeActiveTurn(id)
        if (alive.current && revision === activeTurnRevision.current)
            setDetail(current => ({ ...current, activeTurn: response.activeTurn }))
    }, [api, id])

    const latest = useCallback(async (reset = false) => {
        if (refreshing.current && !reset) return
        if (reset) {
            // Return to latest replaces the history window. An older page may
            // still arrive, but no longer owns this window or its loading state.
            historyGeneration.current += 1
            seekController.current?.abort()
            seekController.current = null
            olderRequest.current = null
            olderPreviousBrowsing.current = null
            browsingOlder.current = false
            setOlderLoading(false)
            setLoading(true)
            historyPages.current.clear()
            boundaries.current.clear()
        }
        const generation = historyGeneration.current
        const revision = tailRevision.current
        const request = Symbol('latest-page')
        refreshing.current = request
        const isCurrent = () => alive.current && generation === historyGeneration.current && refreshing.current === request
        try {
            const page = await api.getCodexNativeItems(id)
            if (!isCurrent()) return
            if (latestTailId.current !== page.data[0]?.item.id) tailRevision.current += 1
            latestTailId.current = page.data[0]?.item.id
            rememberPage(page, 'older')
            const applyLatest = () => setItems(current => {
                const incoming = [...page.data].reverse()
                const previous = new Map(current.map(entry => [entry.item.id, entry]))
                const incomingIds = new Set(incoming.map(entry => entry.item.id))
                const pageEnd = current.findIndex(entry => entry.item.id === incoming.at(-1)?.item.id)
                const streamed = current.filter((entry, index) => typeof entry.reasoningStreamRevision === 'number' &&
                    !incomingIds.has(entry.item.id) && (entry.reasoningStreamRevision > revision ||
                        (!reset && (!incoming.length || (pageEnd !== -1 && index > pageEnd)))))
                return mergeNativeItems(incoming.map(entry => {
                    const live = previous.get(entry.item.id)
                    return typeof live?.reasoningStreamRevision === 'number' && (!reset || live.reasoningStreamRevision > revision)
                        ? reconcileNativeReasoning(live, entry) : entry
                }), streamed, 'latest')
            })
            if (reset) {
                browsingOlder.current = false
                setHasNewer(false)
                applyLatest()
                setCursor(page.nextCursor)
                setNewerCursor(page.backwardsCursor ?? null)
            } else if (browsingOlder.current) {
                if (page.data[0]?.item.id !== itemsRef.current.at(-1)?.item.id) setHasNewer(true)
            } else {
                applyLatest()
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
    }, [api, id, rememberPage])

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
            let lastPage: NativePage<NativeItemEntry> | null = null
            for (let pages = 0; pages < 8 && pageCursor; pages++) {
                lastRequestedCursor = pageCursor
                const page: NativePage<NativeItemEntry> = await readPage(direction, pageCursor)
                lastPage = page
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
            const firstBoundary = boundaries.current.get(nextItems[0]?.item.id)
            const lastId = nextItems.at(-1)?.item.id
            const lastBoundary = lastId ? boundaries.current.get(lastId) : undefined
            const hasMore = Boolean(pageCursor) || (direction === 'newer' && lastPage !== null && pageTailVersions.current.get(lastPage) !== tailRevision.current)
            if (direction === 'older') {
                setCursor(pageCursor)
                const previousEnd = currentItems.at(-1)?.item.id
                if (previousEnd && !nextItems.some(entry => entry.item.id === previousEnd)) {
                    const forward = lastBoundary?.newer === undefined ? oppositeCursor : lastBoundary.newer
                    setNewerCursor(forward)
                    setHasNewer(Boolean(forward))
                    void prefetchFrom('newer', forward)
                }
            } else {
                // Keep the server-issued end cursor reusable if new messages
                // arrive while this reader remains in history mode.
                setNewerCursor(pageCursor ?? lastRequestedCursor)
                setHasNewer(hasMore)
                const previousStart = currentItems[0]?.item.id
                if (previousStart && !nextItems.some(entry => entry.item.id === previousStart)) {
                    const backward = firstBoundary?.older === undefined ? oppositeCursor : firstBoundary.older
                    setCursor(backward)
                    void prefetchFrom('older', backward)
                }
            }
            setError('')
            return { items: nextItems, nextCursor: pageCursor, hasMore }
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
    }, [cursor, newerCursor, readPage, prefetchFrom])
    const older = useCallback((beforeApply?: (entries: NativeItemEntry[]) => boolean) => readHistory('older', beforeApply), [readHistory])
    const newer = useCallback((beforeApply?: (entries: NativeItemEntry[]) => boolean) => readHistory('newer', beforeApply), [readHistory])

    const seekFrom = useCallback(async (
        load: (signal: AbortSignal) => Promise<NativeTurnContextPage>,
        accepts: (entries: NativeItemEntry[]) => boolean
    ) => {
        historyGeneration.current += 1
        seekController.current?.abort()
        const controller = new AbortController()
        seekController.current = controller
        // A seek changes the materialized neighborhood, not the history. Keep
        // completed neighbor pages warm for reverse scrolling. Rollback/latest
        // resets own invalidation of these transport caches.
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
            const page = await load(controller.signal)
            if (!isCurrent()) {
                return false
            }
            const entries = [...page.data].reverse().slice(0, 300)
            if (!accepts(entries) || !isCurrent()) {
                return false
            }
            rememberPage(page, 'older')
            browsingOlder.current = true
            setItems(entries)
            setCursor(page.nextCursor)
            setNewerCursor(page.backwardsCursor ?? page.newerResumeCursor ?? null)
            setHasNewer(Boolean(page.backwardsCursor))
            setError('')
            return true
        } catch (error) {
            if (controller.signal.aborted || !isCurrent()) {
                return false
            }
            throw error
        } finally {
            if (seekController.current === controller) {
                seekController.current = null
            }
            if (isCurrent()) {
                olderRequest.current = null
                setOlderLoading(false)
            }
        }
    }, [rememberPage])
    const seek = useCallback((pageCursor: string | null, accepts: (entries: NativeItemEntry[]) => boolean) => (
        seekFrom(signal => api.getCodexNativeItems(id, pageCursor ?? undefined, 'desc', signal), accepts)
    ), [api, id, seekFrom])
    const seekTurn = useCallback((turnId: string, itemId: string, accepts: (entries: NativeItemEntry[]) => boolean) => (
        seekFrom(signal => api.getCodexNativeTurnContext(id, turnId, itemId, signal), accepts)
    ), [api, id, seekFrom])

    const cancelOlder = useCallback(() => {
        if (!olderRequest.current) return
        if (olderPreviousBrowsing.current !== null) browsingOlder.current = olderPreviousBrowsing.current
        olderPreviousBrowsing.current = null
        historyGeneration.current += 1
        seekController.current?.abort()
        seekController.current = null
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
            if (event.method.startsWith('item/') || event.method === 'turn/started' || event.method === 'turn/completed') tailRevision.current += 1
            if (event.method === 'hapi/heartbeat' || event.method === 'thread/goal/updated' || event.method === 'thread/goal/cleared') return
            if (event.method === 'thread/rolledBack') {
                const saved = cacheKey ? windowCache.get(cacheKey) : undefined
                if (cacheKey && saved) windowCache.set(cacheKey, { ...saved, contextUsage: null })
                setContextUsage(null)
                setHistoryResetRevision(value => value + 1)
                void latest(true)
                return
            }
            if (event.method === 'hapi/ready') {
                setConnected(true)
                settingsRevision.current += 1
                if (Object.hasOwn(event.params, 'activeTurn')) activeTurnRevision.current += 1
                if (event.params.thread) setDetail(current => ({ ...current, ...event.params }))
                if (Array.isArray(event.params.requests)) setRequests((event.params.requests as NativeRequest[]).map(request => ({ ...request, receivedAt: Date.now() })))
                invalidate()
                return
            }
            if (event.method === 'thread/tokenUsage/updated') {
                if (event.params.threadId !== id) return
                const usage = codexContextUsage(event.params.tokenUsage)
                if (usage) setContextUsage(usage)
                return
            }
            if (event.method === 'thread/settings/updated') {
                if (event.params.threadId && event.params.threadId !== id) return
                settingsRevision.current += 1
                setDetail(current => ({ ...current, threadSettings: event.params.threadSettings ?? event.params.settings ?? event.params }))
                return
            }
            if (event.method === 'thread/status/changed') {
                setDetail(current => ({ ...current, thread: { ...record(current.thread), status: event.params.status } }))
                return
            }
            if (event.method === 'turn/started') {
                activeTurnRevision.current += 1
                setDetail(current => ({ ...current, activeTurn: event.params.turn, thread: { ...record(current.thread), status: { type: 'active' } } }))
            }
            if (event.method === 'turn/completed') {
                activeTurnRevision.current += 1
                const turnId = record(event.params.turn).id
                setDetail(current => {
                    const activeId = record(current.activeTurn).id
                    if (activeId && turnId && turnId !== activeId) return current
                    return { ...current, activeTurn: null, thread: { ...record(current.thread), status: { type: 'idle' } } }
                })
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
            if (event.method === 'item/reasoning/summaryPartAdded' || event.method === 'item/reasoning/summaryTextDelta') {
                const { itemId, turnId, summaryIndex, delta } = event.params
                const partAdded = event.method === 'item/reasoning/summaryPartAdded'
                if (browsingOlder.current || typeof itemId !== 'string' || typeof turnId !== 'string' ||
                    typeof summaryIndex !== 'number' || !Number.isSafeInteger(summaryIndex) || summaryIndex < 0 ||
                    (!partAdded && typeof delta !== 'string')) return
                const revision = tailRevision.current
                const observedAtMs = Date.now()
                const text = typeof delta === 'string' ? delta : ''
                setItems(current => {
                    const previous = current.find(entry => entry.item.id === itemId)
                    if (previous && (previous.item.type !== 'reasoning' || previous.completedAtMs != null ||
                        previous.reasoningStreamCompleted === true)) return current
                    const summary = nativeReasoningParts(previous?.item.summary)
                    const prior = summary[summaryIndex]
                    if (partAdded && prior !== undefined) return current
                    summary[summaryIndex] = (prior ?? '') + (partAdded ? '' : text)
                    return mergeNativeItems(current, [{
                        observedAtMs, ...previous, turnId, reasoningStreamRevision: revision,
                        item: { ...previous?.item, id: itemId, type: 'reasoning', summary },
                    }], 'latest')
                })
                return
            }
            if (event.method === 'item/agentMessage/delta' || event.method === 'item/plan/delta') {
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
                const revision = tailRevision.current
                setItems(current => {
                    if (entry.item.type !== 'reasoning') return mergeNativeItems(current, [entry], 'latest')
                    const previous = current.find(value => value.item.id === entry.item.id)
                    const completed = event.method === 'item/completed'
                    const incoming = { ...entry, reasoningStreamRevision: revision, reasoningStreamCompleted: completed }
                    const updated = previous ? reconcileNativeReasoning(previous, incoming) : incoming
                    return mergeNativeItems(current, [{ ...updated, reasoningStreamRevision: revision }], 'latest')
                })
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
            seekController.current?.abort()
            seekController.current = null
            historyPages.current.clear()
            boundaries.current.clear()
            olderRequest.current = null
            refreshing.current = null
            controller.abort()
            clearTimeout(retry)
            clearTimeout(refreshTimer)
        }
    }, [api, id, enabled, cacheKey, latest, refreshDetail, refreshActiveTurn])

    return { detail, contextUsage, items, cursor, newerCursor, loading, olderLoading, error, connected, historyResetRevision, requests, setRequests, hasNewer, older, newer, prefetch, seek, seekTurn, cancelOlder, browseHistory, latest, refreshDetail, applySettings, subscribeEvents }
}
