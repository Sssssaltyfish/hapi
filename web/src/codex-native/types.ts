/** Native daemon records stay native: these types describe only fields the UI reads. */
export type NativeRecord = Record<string, unknown>

export type NativeProject = { id: string; name: string; path: string }
export type NativeStatus = {
    enabled: boolean
    available: boolean
    error?: string
    projects: NativeProject[]
    membership: 'desktop' | 'fallback'
}
export type NativeThread = NativeRecord & {
    id: string
    name?: string | null
    title?: string | null
    preview?: string
    cwd?: string
    status?: unknown
    updatedAt?: number
}
export type NativePage<T> = { data: T[]; nextCursor: string | null }
export type NativeThreadPage = NativePage<NativeThread> & {
    membership: 'desktop' | 'fallback'
    projects: NativeProject[]
}
export type NativeItemEntry = NativeRecord & {
    item: NativeRecord & { id: string; type: string }
    turnId?: string
    startedAtMs?: number | null
    completedAtMs?: number | null
    observedAtMs?: number
}
export type NativeEvent = { method: string; params: NativeRecord }
export type NativeRequest = {
    id: string | number
    method: string
    params: NativeRecord
    receivedAt?: number
}
