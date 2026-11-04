import { record, text, type NativeConnection, type NativeEvent } from './transport'

/** Catalog notifications are global; listening never attaches/resumes a thread. */
export function nativeCatalogEvent(event: NativeEvent): NativeEvent | null {
    const params = record(event.params)
    if (event.method === 'hapi/disconnected') return { method: event.method }
    if (event.method === 'project/changed') {
        const projectId = text(params.projectId)
        return projectId && ['created', 'updated', 'deleted'].includes(String(params.changeType))
            ? { method: event.method, params: { projectId, changeType: params.changeType } } : null
    }
    if (event.method === 'thread/started') {
        const thread = record(params.thread), id = text(thread.id)
        if (!id) return null
        const summary = Object.fromEntries(['name', 'cwd', 'source', 'originator', 'threadSource', 'parentThreadId', 'ephemeral', 'model', 'modelProvider', 'reasoningEffort', 'createdAt', 'updatedAt', 'status']
            .filter(key => Object.hasOwn(thread, key)).map(key => [key, thread[key]]))
        return { method: event.method, params: { thread: { ...summary, id,
            ...(thread.projectId === null || text(thread.projectId) ? { projectId: thread.projectId } : {}),
        } } }
    }
    const threadId = text(params.threadId)
    if (!threadId) return null
    if (event.method === 'thread/project/updated') return params.projectId === null || text(params.projectId)
        ? { method: event.method, params: { threadId, projectId: params.projectId } } : null
    if (event.method === 'thread/name/updated') return {
        method: event.method, params: { threadId, ...(typeof params.threadName === 'string' || params.threadName === null ? { threadName: params.threadName } : {}) },
    }
    if (event.method === 'thread/status/changed' && text(record(params.status).type)) return {
        method: event.method, params: { threadId, status: params.status },
    }
    if (['thread/archived', 'thread/unarchived', 'thread/deleted'].includes(event.method))
        return { method: event.method, params: { threadId } }
    return null
}

type CatalogSubscription = {
    client: NativeConnection
    listeners: Set<(event: NativeEvent) => void>
    ready: Promise<void>
    abort: AbortController
    closed: boolean
    pending: Promise<void>
    waiting: number
    reconciliation?: NativeEvent
}

export type NativeCatalogObserver = {
    observe?: (event: NativeEvent) => Promise<void>
    connected?: (signal: AbortSignal) => Promise<unknown>
}

export class NativeCatalogEvents {
    private current?: CatalogSubscription
    constructor(private createConnection: () => NativeConnection) {}

    dispose(): void {
        const current = this.current
        this.current = undefined
        if (current) this.close(current, true)
    }

    private notify(entry: CatalogSubscription, event: NativeEvent): void {
        for (const listener of [...entry.listeners]) {
            try { listener(event) } catch { /* One departing browser cannot fail another observer. */ }
        }
    }

    private close(entry: CatalogSubscription, notify: boolean): void {
        if (entry.closed) return
        entry.closed = true
        entry.abort.abort()
        if (this.current === entry) this.current = undefined
        if (notify) this.notify(entry, { method: 'hapi/disconnected' })
        entry.client.close('Native catalog subscription closed')
    }

    async subscribe(listener: (event: NativeEvent) => void, observer: NativeCatalogObserver = {}): Promise<() => void> {
        let entry = this.current
        const freshConnection = !entry
        if (!entry) {
            const client = this.createConnection()
            const listeners = new Set<(event: NativeEvent) => void>()
            entry = { client, listeners, ready: Promise.resolve(), abort: new AbortController(), closed: false, pending: Promise.resolve(), waiting: 0 }
            const current = entry
            this.current = current
            client.listeners.add(event => {
                if (current.closed) return
                const catalogEvent = nativeCatalogEvent(event)
                if (!catalogEvent) return
                if (event.method === 'hapi/disconnected') return this.close(current, true)
                if (++current.waiting > 256) return this.close(current, true)
                // Cache mutation belongs to this endpoint observer, not to each browser.
                current.pending = current.pending.then(async () => {
                    if (current.closed) return
                    await observer.observe?.(catalogEvent)
                    if (!current.closed) this.notify(current, catalogEvent)
                }).catch(() => this.close(current, true)).finally(() => { current.waiting-- })
            })
            entry.ready = Promise.resolve().then(() => client.connect()).then(() => {
                if (!current.closed && observer.connected) {
                    // A reconnect catch-up must not delay ready or subsequent viewers.
                    void Promise.resolve().then(() => observer.connected!(current.abort.signal)).then(result => {
                        if (current.closed) return
                        const value = record(result)
                        current.reconciliation = { method: 'hapi/catalogReconciled', params: {
                            complete: value.complete !== false,
                        } }
                        this.notify(current, current.reconciliation)
                    }, () => {
                        if (!current.closed) {
                            current.reconciliation = { method: 'hapi/catalogReconciled', params: { complete: false } }
                            this.notify(current, current.reconciliation)
                        }
                    })
                }
            }).catch(error => {
                this.close(current, true)
                throw error
            })
        }
        const current = entry
        let readyDelivered = false
        const notify = (event: NativeEvent) => {
            // Completion is retained below, so it can be delivered after ready
            // even if this viewer joins while the shared pass is finishing.
            if (event.method === 'hapi/catalogReconciled' && !readyDelivered) return
            listener(event)
        }
        current.listeners.add(notify)
        const release = () => {
            current.listeners.delete(notify)
            if (current.listeners.size === 0) {
                this.close(current, false)
            }
        }
        try {
            await current.ready
            if (this.current !== current || current.closed) throw new Error('Native catalog connection closed')
            listener({ method: 'hapi/catalogReady', params: { freshConnection } })
            readyDelivered = true
            if (current.reconciliation) listener(current.reconciliation)
        } catch (error) {
            release()
            throw error
        }
        let released = false
        return () => {
            if (released) return
            released = true
            release()
        }
    }
}
