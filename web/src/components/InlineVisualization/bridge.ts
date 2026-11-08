export const VISUALIZATION_CHANNEL = 'hapi-visualize'

const STORAGE_KEY = 'hapi.visualization-state.v1'
const MAX_STATE_BYTES = 16 * 1024
const MAX_SNAPSHOTS = 32
const memory = new Map<string, string>()

export function asRecord(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object') return null
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

export function readVisualizationMessage(event: MessageEvent, source: Window | null, bridgeId: string) {
    if (!source || event.source !== source) return null
    const message = asRecord(event.data)
    return message?.channel === VISUALIZATION_CHANNEL && message.bridgeId === bridgeId ? message : null
}

export function encodeWidgetState(value: unknown): string | null {
    const state = asRecord(value)
    if (!state || Object.keys(state).some(key => key !== 'modelContent' && key !== 'privateContent')) return null

    // Structured clone also accepts objects and values that JSON cannot represent.
    let budget = MAX_STATE_BYTES
    function isJson(item: unknown, depth = 0): boolean {
        if (--budget < 0 || depth > 64) return false
        if (item === null || typeof item === 'boolean') return true
        if (typeof item === 'number') return Number.isFinite(item)
        if (typeof item === 'string') return (budget -= item.length) >= 0
        if (Array.isArray(item)) {
            if (item.length > budget) return false
            for (const child of item) if (!isJson(child, depth + 1)) return false
            return true
        }
        const record = asRecord(item)
        if (!record) return false
        for (const key in record) {
            if (Object.hasOwn(record, key) && ((budget -= key.length) < 0 || !isJson(record[key], depth + 1))) return false
        }
        return true
    }

    const snapshot = {
        modelContent: Object.hasOwn(state, 'modelContent') ? state.modelContent : null,
        privateContent: Object.hasOwn(state, 'privateContent') ? state.privateContent : null,
    }
    if (!isJson(snapshot)) return null
    const serialized = JSON.stringify(snapshot)
    return new TextEncoder().encode(serialized).byteLength <= MAX_STATE_BYTES ? serialized : null
}

function savedSnapshots(): Map<string, string> {
    try {
        const value = localStorage.getItem(STORAGE_KEY)
        if (value && value.length <= MAX_SNAPSHOTS * MAX_STATE_BYTES * 2) return new Map(JSON.parse(value))
    } catch { /* Storage may be unavailable in this browser. */ }
    return new Map()
}

function remember(snapshots: Map<string, string>, key: string, value: string) {
    snapshots.delete(key)
    snapshots.set(key, value)
    while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!)
}

export function readWidgetState(key: string, persistent: boolean): unknown {
    const stored = memory.get(key) ?? (persistent ? savedSnapshots().get(key) : undefined)
    if (typeof stored !== 'string' || stored.length > MAX_STATE_BYTES) return null
    try { return JSON.parse(stored) } catch { return null }
}

export function saveWidgetState(key: string, persistent: boolean, value: string) {
    remember(memory, key, value)
    if (!persistent) return

    try {
        const snapshots = savedSnapshots()
        remember(snapshots, key, value)
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...snapshots]))
    } catch { /* Keep the in-memory snapshot for this page. */ }
}
