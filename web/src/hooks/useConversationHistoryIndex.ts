import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { ConversationHistoryPage, ConversationOutlineItem } from '@/chat/outline'
import { getMessageWindowState, seekMessageWindow } from '@/lib/message-window-store'
import {
    firstOutlinePage, getOutlineCache, mergeOutlineItems, OUTLINE_REVALIDATE_MS,
    OUTLINE_ACTIVE_BYTES, outlineBytes, publishOutlineCache, resetOutlineCache,
} from '@/lib/conversation-outline-cache'

const memoryScopes = new WeakMap<ApiClient, string>()
function scopeFor(api: ApiClient) {
    if (typeof api.getConversationCacheScope === 'function') return api.getConversationCacheScope()
    let key = memoryScopes.get(api)
    if (!key) {
        key = Math.random().toString(36)
        memoryScopes.set(api, key)
    }
    return { key, persistent: false }
}
const yieldToPage = () => new Promise<void>(resolve => setTimeout(resolve, 20))

/** User previews and real page locators have their own continuity, independent of the viewport. */
export function useConversationHistoryIndex(options: {
    api: ApiClient
    session: Session
    open: boolean
    currentItems: ConversationOutlineItem[]
    messagesVersion: number
    viewMode?: 'tail' | 'history'
    conversationHistoryRevision?: number
    onLocateNativePage?: (cursor: string | null, targetMessageId: string) => Promise<boolean>
}) {
    const { api, session, open, messagesVersion, onLocateNativePage, conversationHistoryRevision = 0 } = options
    const visibleSignature = JSON.stringify(options.currentItems)
    // Tool tokens rebuild viewport blocks, but do not change these short user previews.
    const currentItems = useMemo(() => options.currentItems, [visibleSignature])
    const native = session.metadata?.nativeCodex
    const scope = scopeFor(api)
    const key = JSON.stringify([scope.key, native ? ['native', native.endpointId, native.threadId] : ['runner', session.id]])
    const cache = useMemo(() => getOutlineCache(key, Boolean(native), scope.persistent), [key, Boolean(native), scope.persistent])
    const [, render] = useState(0)
    const [locating, setLocating] = useState(false)
    const [scannedPages, setScannedPages] = useState(0)
    const [error, setError] = useState<string | null>(null)
    const alive = useRef(true)
    const openRef = useRef(open)
    openRef.current = open
    const activeKey = useRef(key)
    activeKey.current = key
    const locateRequest = useRef<symbol | null>(null)
    const revision = useRef({ key, value: conversationHistoryRevision })
    const observedVersion = useRef({ key, value: messagesVersion })

    useEffect(() => {
        alive.current = true
        const changed = () => {
            if (cache.listeners.has(changed)) render(value => value + 1)
        }
        cache.listeners.add(changed)
        cache.pins++
        void cache.hydrated.then(changed)
        return () => {
            alive.current = false
            cache.listeners.delete(changed)
            cache.pins--
        }
    }, [cache])

    const read = useCallback((page: ConversationHistoryPage, stopId?: string | string[]) =>
        api.getConversationOutline(native?.threadId ?? session.id, page, stopId), [api, native?.threadId, session.id])

    const loadEarlier = useCallback(async () => {
        if (cache.request) return cache.request
        if (cache.failed) return
        let succeeded = false
        const generation = cache.generation
        const current = () => alive.current && activeKey.current === key && cache.generation === generation
        setError(null)
        cache.request = (async () => {
            await cache.hydrated
            if (!current()) return
            const headRevision = cache.headRevision
            // Revalidation has its own cursor. It never throws away the older continuation.
            if (cache.initialized && Date.now() - cache.checkedAt >= OUTLINE_REVALIDATE_MS) {
                const previous = cache.items
                const stopIds = [...previous].reverse().filter(item => item.historyPage).slice(0, 64).map(item => item.targetMessageId)
                let cursor: ConversationHistoryPage | null = firstOutlinePage(Boolean(native))
                const refreshed: ConversationOutlineItem[] = []
                let refreshedBytes = 2
                let overlapId: string | undefined
                do {
                    const page = await read(cursor!, stopIds)
                    if (!current()) return
                    if (!native && cache.epoch !== null && page.epoch !== cache.epoch) {
                        resetOutlineCache(cache, false)
                        return
                    }
                    refreshedBytes += page.items.reduce((sum, item) => sum + outlineBytes(item) + 1, 0)
                    if (refreshedBytes > OUTLINE_ACTIVE_BYTES) {
                        cache.capped = true
                        cache.next ??= firstOutlinePage(Boolean(native))
                        return
                    }
                    refreshed.push(...page.items)
                    cache.epoch = page.epoch
                    overlapId = page.overlapId
                    setScannedPages(value => value + page.scanned)
                    render(value => value + 1)
                    cursor = page.next
                    if (cursor && openRef.current) await yieldToPage()
                } while (cursor && openRef.current && current())
                if (!current()) return
                if (cursor) return
                const overlap = previous.findIndex(item => item.targetMessageId === overlapId)
                const newestKnown = stopIds[0]
                if (stopIds.length && overlapId !== newestKnown) {
                    // Offline rewind can remove only the cached prefix. Preserve the
                    // surviving previews, invalidate old locators, and rebuild continuity.
                    const originalIds = new Set(previous.map(item => item.id))
                    const live = cache.items.filter(item => !originalIds.has(item.id))
                    cache.items = [...(overlap < 0 ? [] : previous.slice(0, overlap + 1)), ...live]
                        .map(item => ({ ...item, historyPage: undefined }))
                    cache.bytes = outlineBytes(cache.items)
                    cache.capped = false
                    // Re-read the real page containing the overlap, including items
                    // after the boundary that the head-only response intentionally omits.
                    cache.next = refreshed.find(item => item.targetMessageId === overlapId)?.historyPage ?? null
                }
                if (!stopIds.length) {
                    cache.items = []
                    cache.bytes = 2
                    cache.next = null
                    cache.capped = false
                }
                mergeOutlineItems(cache, refreshed)
                cache.checkedAt = headRevision === cache.headRevision ? Date.now() : 0
                publishOutlineCache(cache)
            }
            while (cache.next && !cache.capped && openRef.current && current()) {
                const before = cache.next
                const page = await read(before)
                if (!current()) return
                if (!native && cache.epoch !== null && page.epoch !== cache.epoch) {
                    resetOutlineCache(cache, false)
                    return
                }
                const allRetained = mergeOutlineItems(cache, page.items)
                cache.next = allRetained ? page.next : before
                if (!cache.initialized) cache.checkedAt = headRevision === cache.headRevision ? Date.now() : 0
                cache.initialized = true
                cache.epoch = page.epoch
                setScannedPages(value => value + page.scanned)
                publishOutlineCache(cache)
                if (cache.next && !cache.capped) await yieldToPage()
            }
            succeeded = true
            if (!cache.next && !cache.capped) cache.cursorRecovery = false
        })().catch(reason => {
            if (!current()) return
            if (native && !cache.cursorRecovery && /invalid.*cursor|cursor.*invalid|rolled.back|rewind/i.test(String(reason))) {
                // Keep previews visible while rebuilding invalid opaque pagination.
                cache.items = cache.items.map(item => ({ ...item, historyPage: undefined }))
                cache.bytes = outlineBytes(cache.items)
                cache.next = firstOutlinePage(true)
                cache.checkedAt = 0
                cache.initialized = true
                cache.generation++
                cache.cursorRecovery = true
            } else {
                cache.failed = true
                setError(String(reason))
            }
        }).finally(() => {
            cache.request = null
            publishOutlineCache(cache)
            // A reset or live input can invalidate the head during an older scan.
            if ((succeeded || cache.generation !== generation) && alive.current && activeKey.current === key
                && openRef.current && cache.checkedAt === 0 && !cache.capped) void loadEarlier()
        })
        publishOutlineCache(cache)
        return cache.request
    }, [cache, key, Boolean(native), read])

    useEffect(() => {
        if (revision.current.key === key && revision.current.value !== conversationHistoryRevision) resetOutlineCache(cache, Boolean(native))
        revision.current = { key, value: conversationHistoryRevision }
        if (!native) {
            const epoch = getMessageWindowState(session.id).epoch
            if (cache.epoch !== null && epoch !== null && epoch !== cache.epoch) resetOutlineCache(cache, false)
        }
        mergeOutlineItems(cache, currentItems)
        publishOutlineCache(cache)
    }, [cache, currentItems, conversationHistoryRevision, key, Boolean(native), session.id, messagesVersion])

    useEffect(() => {
        if (!open) return
        void cache.hydrated.then(async () => {
            if (alive.current && activeKey.current === key) {
                cache.checkedAt = 0
                cache.failed = false
                cache.cursorRecovery = false
                // A previous mounted view may still own a request whose result it
                // must discard. This consumer takes over once that request settles.
                while (cache.request && alive.current && activeKey.current === key && openRef.current) {
                    await cache.request
                }
                if (alive.current && activeKey.current === key && openRef.current) void loadEarlier()
            }
        })
    }, [open, cache, key, loadEarlier])

    useEffect(() => {
        if (observedVersion.current.key === key && observedVersion.current.value === messagesVersion) return
        observedVersion.current = { key, value: messagesVersion }
        // Coalesce stream updates; a head scan must not repeatedly reset older progress.
        const timer = setTimeout(() => {
            cache.headRevision++
            cache.checkedAt = 0
            if (openRef.current) void loadEarlier()
        }, 1500)
        return () => clearTimeout(timer)
    }, [messagesVersion, cache, key, loadEarlier])

    useEffect(() => {
        if (!open) return
        const timer = setInterval(() => {
            void loadEarlier()
        }, OUTLINE_REVALIDATE_MS)
        return () => clearInterval(timer)
    }, [open, loadEarlier])

    const locate = useCallback(async (item: ConversationOutlineItem, isCurrent: () => boolean = () => true): Promise<boolean> => {
        const token = Symbol('outline-locate')
        locateRequest.current = token
        const generation = cache.generation
        const current = () => alive.current && activeKey.current === key && generation === cache.generation && isCurrent() && locateRequest.current === token
        const seek = (candidate: ConversationOutlineItem) => candidate.historyPage?.kind === 'native'
            ? onLocateNativePage?.(candidate.historyPage.cursor, candidate.targetMessageId) ?? Promise.resolve(false)
            : candidate.historyPage?.kind === 'runner' ? seekMessageWindow(api, session.id, candidate.historyPage, candidate.targetMessageId) : Promise.resolve(false)
        setError(null)
        setLocating(true)
        try {
            const candidate = cache.items.find(value => value.id === item.id) ?? item
            if (candidate.historyPage && await seek(candidate)) return current()
            let cursor: ConversationHistoryPage | null = firstOutlinePage(Boolean(native))
            while (cursor && current()) {
                const page = await read(cursor, item.targetMessageId)
                if (!current()) return false
                mergeOutlineItems(cache, page.items)
                publishOutlineCache(cache)
                const found = page.items.find(value => value.targetMessageId === item.targetMessageId)
                if (found?.historyPage && await seek(found)) return current()
                cursor = page.next
                if (cursor) await yieldToPage()
            }
            if (current()) setError('This message is no longer available in the current conversation history.')
        } catch (reason) {
            if (current()) setError(String(reason))
        }
        finally {
            if (alive.current && locateRequest.current === token) {
                locateRequest.current = null
                setLocating(false)
            }
        }
        return false
    }, [api, cache, key, Boolean(native), onLocateNativePage, read, session.id])

    const items = useMemo(() => {
        const merged = new Map([...cache.items, ...currentItems].map(item => [item.id, item]))
        for (const item of cache.items) if (merged.has(item.id)) merged.set(item.id, { ...merged.get(item.id)!, historyPage: item.historyPage })
        return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    }, [cache.items, currentItems])
    const retry = useCallback(() => {
        cache.failed = false
        cache.cursorRecovery = false
        return loadEarlier()
    }, [cache, loadEarlier])
    return {
        items,
        hasEarlier: Boolean(cache.next),
        loading: Boolean(cache.request) || locating,
        error,
        scannedPages,
        loadEarlier: retry,
        locate,
        capped: cache.capped
    }
}
