import type { ConversationOutlineContinuation, ConversationOutlineItem } from '@/chat/outline'

export const OUTLINE_ACTIVE_BYTES = 8 * 1024 * 1024
export const OUTLINE_TOTAL_BYTES = 32 * 1024 * 1024
export const OUTLINE_IDLE_TTL_MS = 30 * 60_000
export const OUTLINE_REVALIDATE_MS = 5 * 60_000
export type OutlineCache = {
    key: string
    items: ConversationOutlineItem[]
    next: ConversationOutlineContinuation | null
    initialized: boolean
    epoch: number | null
    checkedAt: number
    usedAt: number
    bytes: number
    generation: number
    headRevision: number
    capped: boolean
    hydrated: Promise<void>
    request: Promise<void> | null
    listeners: Set<() => void>
    pins: number
    persistent: boolean
    cursorRecovery: boolean
    failed: boolean
}
type StoredIndex = Pick<OutlineCache, 'key' | 'items' | 'next' | 'initialized' | 'epoch' | 'checkedAt' | 'usedAt' | 'bytes' | 'capped'>
const entries = new Map<string, OutlineCache>()
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
const encoder = new TextEncoder()
const dbName = 'hapi-conversation-outline-v1'
const lookups = new WeakMap<OutlineCache, {
    items: ConversationOutlineItem[]
    byId: Map<string, ConversationOutlineItem>
}>()
const snapshots = new WeakMap<OutlineCache, {
    items: ConversationOutlineItem[]
    metadata: string
}>()

export function outlineBytes(value: unknown): number {
    return encoder.encode(JSON.stringify(value)).byteLength
}
export function firstOutlinePage(native: boolean): ConversationOutlineContinuation {
    return native ? { kind: 'native-turns', cursor: null } : {
        kind: 'runner',
        beforeAt: null,
        beforeSeq: null,
        epoch: null
    }
}
export function resetOutlineCache(cache: OutlineCache, native: boolean): void {
    cache.items = []
    cache.next = firstOutlinePage(native)
    cache.initialized = false
    cache.epoch = null
    cache.checkedAt = 0
    cache.bytes = 2
    cache.capped = false
    cache.generation++
    cache.failed = false
    cache.cursorRecovery = false
    publishOutlineCache(cache)
}
export function publishOutlineCache(cache: OutlineCache): void {
    cache.usedAt = Date.now()
    for (const listener of cache.listeners) listener()
    pruneMemory()
    if (!cache.persistent || typeof indexedDB === 'undefined') return
    const metadata = JSON.stringify([cache.next, cache.initialized, cache.epoch, cache.capped])
    const previous = snapshots.get(cache)
    if (previous?.items === cache.items && previous.metadata === metadata) return
    snapshots.set(cache, { items: cache.items, metadata })
    clearTimeout(writeTimers.get(cache.key))
    writeTimers.set(cache.key, setTimeout(() => {
        writeTimers.delete(cache.key)
        void cache.hydrated.then(() => persist(cache)).catch(() => {
            /* Rebuildable previews remain usable in memory. */
        })
    }, 250))
}

export function mergeOutlineItems(cache: OutlineCache, items: readonly ConversationOutlineItem[]): boolean {
    let lookup = lookups.get(cache)
    if (lookup?.items !== cache.items) {
        lookup = { items: cache.items, byId: new Map(cache.items.map(item => [item.id, item])) }
        lookups.set(cache, lookup)
    }
    let merged: Map<string, ConversationOutlineItem> | undefined
    let bytes = cache.bytes
    let retainedAll = true
    for (const item of items) {
        if (item.transient) continue
        const previous = (merged ?? lookup.byId).get(item.id)
        const candidate = { ...item, historyPage: item.historyPage ?? previous?.historyPage }
        if (previous && previous.label === candidate.label && previous.createdAt === candidate.createdAt
            && previous.targetMessageId === candidate.targetMessageId
            && JSON.stringify(previous.historyPage) === JSON.stringify(candidate.historyPage)
            && JSON.stringify(previous.indexPage) === JSON.stringify(candidate.indexPage)
            && JSON.stringify(previous.nativeTurn) === JSON.stringify(candidate.nativeTurn)) continue
        const cost = outlineBytes(candidate) + (previous ? 0 : 1) - (previous ? outlineBytes(previous) : 0)
        if (bytes + cost > OUTLINE_ACTIVE_BYTES) {
            retainedAll = false
            continue
        }
        merged ??= new Map(lookup.byId)
        merged.set(item.id, candidate)
        bytes += cost
    }
    if (merged) {
        cache.items = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        lookups.set(cache, { items: cache.items, byId: merged })
    }
    cache.bytes = bytes
    cache.capped ||= !retainedAll
    return retainedAll
}

function pruneMemory(): void {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of [...entries.values()].sort((a, b) => a.usedAt - b.usedAt)) {
        if (entry.pins || entry.request) continue
        if (bytes <= OUTLINE_TOTAL_BYTES && Date.now() - entry.usedAt < OUTLINE_IDLE_TTL_MS) continue
        entries.delete(entry.key)
        bytes -= entry.bytes
    }
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 2)
        request.onupgradeneeded = () => {
            const db = request.result
            const existed = db.objectStoreNames.contains('indexes')
            if (!existed) db.createObjectStore('indexes', { keyPath: 'key' })
            if (!db.objectStoreNames.contains('metadata')) {
                const metadata = db.createObjectStore('metadata', { keyPath: 'key' })
                if (existed) {
                    const cursor = request.transaction!.objectStore('indexes').openCursor()
                    cursor.onsuccess = () => {
                        const entry = cursor.result
                        if (!entry) return
                        const value = entry.value as StoredIndex
                        metadata.put({ key: value.key, bytes: value.bytes, usedAt: value.usedAt })
                        entry.continue()
                    }
                }
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}
function stored(cache: OutlineCache): StoredIndex {
    return {
        key: cache.key,
        items: cache.items,
        next: cache.next,
        initialized: cache.initialized,
        epoch: cache.epoch,
        checkedAt: cache.checkedAt,
        usedAt: cache.usedAt,
        bytes: cache.bytes,
        capped: cache.capped
    }
}
async function hydrate(cache: OutlineCache): Promise<void> {
    if (!cache.persistent || typeof indexedDB === 'undefined') return
    const generation = cache.generation
    const db = await openDb()
    try {
        const value = await new Promise<StoredIndex | undefined>((resolve, reject) => {
            const request = db.transaction('indexes').objectStore('indexes').get(cache.key)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        if (!value || cache.generation !== generation || !Array.isArray(value.items) || value.bytes > OUTLINE_ACTIVE_BYTES) return
        // Locators and continuity belong to this complete snapshot, never to a later reset.
        const live = cache.items
        cache.items = value.items
        cache.next = value.next
        cache.initialized = value.initialized
        cache.epoch = value.epoch
        cache.checkedAt = value.checkedAt
        cache.bytes = outlineBytes(value.items)
        cache.capped = value.capped
        mergeOutlineItems(cache, live)
        for (const listener of cache.listeners) listener()
    } finally {
        db.close()
    }
}
async function persist(cache: OutlineCache): Promise<void> {
    const snapshot = stored(cache)
    const db = await openDb()
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(['indexes', 'metadata'], 'readwrite')
            const store = transaction.objectStore('indexes')
            store.put(snapshot)
            const metadata = transaction.objectStore('metadata')
            metadata.put({ key: snapshot.key, bytes: snapshot.bytes, usedAt: snapshot.usedAt })
            // LRU reads only the small metadata store, never other prompt indexes.
            const rows: Array<{
                key: string
                bytes: number
                usedAt: number
            }> = []
            const cursor = metadata.openCursor()
            cursor.onsuccess = () => {
                const entry = cursor.result
                if (entry) {
                    const value = entry.value as {
                        key: string
                        bytes: number
                        usedAt: number
                    }
                    rows.push({ key: value.key, bytes: value.bytes, usedAt: value.usedAt })
                    entry.continue()
                    return
                }
                let bytes = rows.reduce((sum, row) => sum + row.bytes, 0)
                for (const row of rows.sort((a, b) => a.usedAt - b.usedAt)) {
                    if (row.key === cache.key || entries.get(row.key)?.pins) continue
                    if (bytes <= OUTLINE_TOTAL_BYTES) break
                    store.delete(row.key)
                    metadata.delete(row.key)
                    bytes -= row.bytes
                }
            }
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
        })
    } finally {
        db.close()
    }
}

export function getOutlineCache(key: string, native: boolean, persistent: boolean): OutlineCache {
    let cache = entries.get(key)
    if (!cache) {
        cache = {
            key,
            items: [],
            next: firstOutlinePage(native),
            initialized: false,
            epoch: null,
            checkedAt: 0,
            usedAt: Date.now(),
            bytes: 2,
            generation: 0,
            headRevision: 0,
            capped: false,
            request: null,
            listeners: new Set(),
            pins: 0,
            persistent,
            cursorRecovery: false,
            failed: false,
            hydrated: Promise.resolve()
        }
        entries.set(key, cache)
        cache.hydrated = hydrate(cache).catch(() => {

        })
    }
    cache.usedAt = Date.now()
    return cache
}
