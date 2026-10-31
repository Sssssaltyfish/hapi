import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'
import { buildConversationOutline, type ConversationHistoryPage, type ConversationOutlineItem } from '@/chat/outline'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { projectNativeItems } from '@/codex-native/projectNativeItems'
import { getMessageWindowState, seekMessageWindow } from '@/lib/message-window-store'

const MAX_INDEX_ITEMS = 1000
const MAX_CACHED_SESSIONS = 12
const INDEX_TTL_MS = 5 * 60 * 1000
type IndexCache = {
    items: ConversationOutlineItem[]
    next: ConversationHistoryPage | null
    initialized: boolean
    updatedAt: number
    epoch: number | null
    generation: number
}
const caches = new Map<string, IndexCache>()

function newCache(native: boolean): IndexCache {
    return {
        items: [],
        next: native ? { kind: 'native', cursor: null } : { kind: 'runner', beforeAt: null, beforeSeq: null, epoch: null },
        initialized: false,
        updatedAt: Date.now(),
        epoch: null,
        generation: 0,
    }
}

/** The index retains prompt previews and page locators, never complete history pages. */
export function useConversationHistoryIndex(options: {
    api: ApiClient
    session: Session
    open: boolean
    currentItems: ConversationOutlineItem[]
    messagesVersion: number
    viewMode?: 'tail' | 'history'
    onLocateNativePage?: (cursor: string | null, targetMessageId: string) => Promise<boolean>
}) {
    const { api, session, open, currentItems, messagesVersion, onLocateNativePage, viewMode = 'tail' } = options
    const native = session.metadata?.nativeCodex
    const key = native ? `native:${native.endpointId}:${native.threadId}` : `runner:${session.id}`
    const cacheRef = useRef<IndexCache | null>(null)
    if (!cacheRef.current) {
        let cached = caches.get(key)
        if (!cached || Date.now() - cached.updatedAt > INDEX_TTL_MS) cached = newCache(Boolean(native))
        caches.delete(key)
        caches.set(key, cached)
        while (caches.size > MAX_CACHED_SESSIONS) caches.delete(caches.keys().next().value!)
        cacheRef.current = cached
    }
    const [, render] = useState(0)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const requestRef = useRef<symbol | null>(null)
    const locateRequestRef = useRef<symbol | null>(null)
    const observedVersion = useRef(messagesVersion)
    const alive = useRef(true)
    useEffect(() => {
        alive.current = true
        return () => { alive.current = false; requestRef.current = null }
    }, [])

    const invalidateHead = useCallback(() => {
        const cache = cacheRef.current!
        cache.items = cache.items.map(item => item.historyPage && (
            item.historyPage.kind === 'native' ? item.historyPage.cursor === null : item.historyPage.beforeAt === null
        ) ? { ...item, historyPage: undefined } : item)
        cache.next = newCache(Boolean(native)).next
        cache.generation += 1
        // A refresh remains explicit after live updates, so streaming cannot
        // repeatedly restart an automatic scan while someone searches history.
        cache.initialized = true
        cache.updatedAt = Date.now()
        requestRef.current = null
        setLoading(false)
        render(value => value + 1)
    }, [Boolean(native)])

    useEffect(() => {
        const cache = cacheRef.current!
        const known = new Map(cache.items.map(item => [item.id, item]))
        if (viewMode === 'tail' && (cache.initialized || requestRef.current !== null) && currentItems.some(item => !known.has(item.id))) invalidateHead()
        if (observedVersion.current !== messagesVersion) {
            observedVersion.current = messagesVersion
            // Opaque older cursors remain native. A null cursor means "latest",
            // whose contents can drift even when only assistant items arrive.
            cache.items = cache.items.map(item => item.historyPage?.kind === 'native' && item.historyPage.cursor === null
                ? { ...item, historyPage: undefined } : item)
        }
        const merged = new Map(cache.items.map(item => [item.id, item]))
        for (const item of currentItems) merged.set(item.id, { ...item, historyPage: merged.get(item.id)?.historyPage ?? item.historyPage })
        cache.items = [...merged.values()].slice(-MAX_INDEX_ITEMS)
        render(value => value + 1)
    }, [currentItems, messagesVersion, viewMode, invalidateHead])

    const cacheUpdatedAt = cacheRef.current.updatedAt
    useEffect(() => {
        const timer = setTimeout(invalidateHead, Math.max(0, INDEX_TTL_MS - (Date.now() - cacheUpdatedAt)))
        return () => clearTimeout(timer)
    }, [cacheUpdatedAt, invalidateHead])

    // Runner epochs explicitly invalidate page positions after rewind/reset.
    useEffect(() => {
        if (native) return
        const epoch = getMessageWindowState(session.id).epoch
        const cache = cacheRef.current!
        if (cache.epoch !== null && epoch !== null && epoch !== cache.epoch) {
            Object.assign(cache, newCache(false))
            requestRef.current = null
            setLoading(false)
            render(value => value + 1)
        }
    }, [native, session.id, messagesVersion])

    const loadEarlier = useCallback(async () => {
        const cache = cacheRef.current!
        if (requestRef.current || !cache.next) return
        const token = Symbol('outline-page')
        const generation = cache.generation
        requestRef.current = token
        setLoading(true)
        setError(null)
        const locator = cache.next
        try {
            let messages: DecryptedMessage[]
            let next: ConversationHistoryPage | null
            let epoch = cache.epoch
            if (locator.kind === 'native' && native) {
                const page = await api.getCodexNativeItems(native.threadId, locator.cursor ?? undefined)
                messages = projectNativeItems([...page.data].reverse(), [], false).messages
                if (page.nextCursor !== null && page.nextCursor === locator.cursor) throw new Error('History cursor did not advance')
                next = page.nextCursor ? { kind: 'native', cursor: page.nextCursor } : null
            } else if (locator.kind === 'runner') {
                const page = await api.getMessages(session.id, { beforeAt: locator.beforeAt, beforeSeq: locator.beforeSeq, limit: 200 })
                messages = page.messages
                if (locator.epoch !== null && locator.epoch !== page.page.epoch) {
                    if (alive.current && requestRef.current === token) Object.assign(cache, newCache(false))
                    throw new Error('Conversation history changed. Load the outline again to refresh.')
                }
                epoch = page.page.epoch
                next = page.page.hasMore && page.page.nextBeforeAt !== null && page.page.nextBeforeSeq !== null
                    ? { kind: 'runner', beforeAt: page.page.nextBeforeAt, beforeSeq: page.page.nextBeforeSeq, epoch: page.page.epoch }
                    : null
                if (next?.kind === 'runner' && next.beforeAt === locator.beforeAt && next.beforeSeq === locator.beforeSeq) throw new Error('History cursor did not advance')
            } else return
            if (!alive.current || requestRef.current !== token || cache.generation !== generation) return
            cache.epoch = epoch
            const normalized = messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
            const stableLocator = locator.kind === 'runner' ? { ...locator, epoch: cache.epoch } : locator
            const items = buildConversationOutline(reduceChatBlocks(normalized, null).blocks).map(item => ({ ...item, historyPage: stableLocator }))
            const merged = new Map([...cache.items, ...items].map(item => [item.id, item]))
            // Retain the most recently scanned entries when this bounded cache fills.
            cache.items = [...merged.values()].slice(-MAX_INDEX_ITEMS)
            cache.next = next
            cache.initialized = true
            cache.updatedAt = Date.now()
            render(value => value + 1)
        } catch (error) {
            if (alive.current && requestRef.current === token) setError(String(error))
        } finally {
            if (alive.current && requestRef.current === token) {
                requestRef.current = null
                setLoading(false)
            }
        }
    }, [api, native?.threadId, session.id])

    useEffect(() => {
        if (open && !cacheRef.current!.initialized) void loadEarlier()
    }, [open, loadEarlier])

    const locate = useCallback(async (item: ConversationOutlineItem, isCurrent: () => boolean = () => true): Promise<boolean> => {
        const request = Symbol('outline-locate')
        locateRequestRef.current = request
        setError(null)
        setLoading(true)
        const current = () => alive.current && isCurrent() && locateRequestRef.current === request
        const seek = (candidate: ConversationOutlineItem) => candidate.historyPage?.kind === 'native'
            ? onLocateNativePage?.(candidate.historyPage.cursor, candidate.targetMessageId) ?? Promise.resolve(false)
            : candidate.historyPage?.kind === 'runner'
                ? seekMessageWindow(api, session.id, candidate.historyPage, candidate.targetMessageId)
                : Promise.resolve(false)
        try {
            let candidate = cacheRef.current!.items.find(value => value.id === item.id) ?? item
            if (candidate.historyPage && await seek(candidate)) return current()
            if (!current()) return false
            cacheRef.current!.items = cacheRef.current!.items.map(value => value.id === item.id ? { ...value, historyPage: undefined } : value)
            invalidateHead()
            // A drifting head locator is repaired with a small explicit scan.
            // Older pages remain available through Load earlier after this budget.
            for (let page = 0; page < 3 && current() && cacheRef.current!.next; page++) {
                const beforeItems = cacheRef.current!.items
                const beforeNext = cacheRef.current!.next
                await loadEarlier()
                if (!current()) return false
                candidate = cacheRef.current!.items.find(value => value.id === item.id) ?? { ...item, historyPage: undefined }
                setLoading(true)
                if (candidate.historyPage && await seek(candidate)) return current()
                if (beforeItems === cacheRef.current!.items && beforeNext === cacheRef.current!.next) break
            }
            if (current()) setError(cacheRef.current!.next
                ? 'This prompt is outside the pages indexed so far. Use ↑ to continue indexing earlier pages, then select it again.'
                : 'This message is no longer available in the current conversation history.')
            return false
        } catch (error) {
            if (current()) { invalidateHead(); setError(String(error)) }
            return false
        } finally {
            if (alive.current && locateRequestRef.current === request) { locateRequestRef.current = null; setLoading(false) }
        }
    }, [api, onLocateNativePage, session.id, invalidateHead, loadEarlier])
    const cache = cacheRef.current
    const items = useMemo(() => {
        const merged = new Map([...cache.items, ...currentItems].map(item => [item.id, item]))
        // Keep a locator for visible messages that were also indexed.
        for (const item of cache.items) if (merged.has(item.id)) merged.set(item.id, { ...merged.get(item.id)!, historyPage: item.historyPage })
        return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
    }, [cache.items, currentItems])
    return { items, hasEarlier: Boolean(cache.next), loading, error, loadEarlier, locate, capped: cache.items.length >= MAX_INDEX_ITEMS }
}
