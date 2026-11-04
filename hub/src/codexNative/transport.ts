import WebSocket from 'ws'

export type NativeRecord = Record<string, unknown>
export type NativeEvent = { method: string; params?: unknown }
export type NativeRequest = NativeEvent & { id: string | number }
export const record = (value: unknown): NativeRecord =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as NativeRecord)
        : {}
export const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined

/** A detachable client of an existing daemon. Never launches Codex or persists history. */
export class NativeConnection {
    private socket?: WebSocket
    private ready?: Promise<void>
    private sequence = 0
    private pending = new Map<
        number,
        {
            resolve(value: unknown): void
            reject(error: Error): void
            timer: ReturnType<typeof setTimeout>
        }
    >()
    readonly requests = new Map<string, NativeRequest>()
    readonly listeners = new Set<(event: NativeEvent) => void>()
    private disposed = false
    initialization: NativeRecord = {}
    constructor(
        private endpoint: string,
        private token?: string
    ) {}

    connect(): Promise<void> {
        if (this.ready) return this.ready
        this.ready = new Promise<void>((resolve, reject) => {
            const url = this.endpoint.startsWith('unix://')
                ? `ws+unix://${this.endpoint.slice(7)}:/`
                : this.endpoint
            const socket = (this.socket = new WebSocket(url, {
                headers: {
                    Host: 'localhost',
                    ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
                },
                handshakeTimeout: 10_000,
                maxPayload: 0,
                perMessageDeflate: false,
            }))
            socket.once('error', reject)
            socket.once('open', () => {
                void this.rawRequest('initialize', {
                    clientInfo: { name: 'hapi-native', title: 'HAPI Native', version: '1' },
                    capabilities: { experimentalApi: true },
                }).then((result) => {
                    this.initialization = record(result)
                    socket.send(JSON.stringify({ method: 'initialized' }))
                    resolve()
                }, reject)
            })
            socket.on('message', (raw) => {
                try {
                    this.receive(record(JSON.parse(raw.toString())))
                } catch {
                    this.close('Invalid native response')
                }
            })
            socket.on('close', () =>
                this.close('Native connection closed; refresh before retrying a mutation')
            )
            socket.on('error', () =>
                this.close('Native connection failed; mutation outcome may be unknown')
            )
        })
        return this.ready
    }
    private emit(event: NativeEvent): void {
        for (const listener of this.listeners) listener(event)
    }
    private receive(message: NativeRecord): void {
        if (!message.method && typeof message.id === 'number') {
            const pending = this.pending.get(message.id)
            if (!pending) return
            this.pending.delete(message.id)
            clearTimeout(pending.timer)
            if (message.error)
                pending.reject(
                    new Error(text(record(message.error).message) ?? 'Native request failed')
                )
            else pending.resolve(message.result)
            return
        }
        const method = text(message.method)
        if (!method) return
        if (typeof message.id === 'number' || typeof message.id === 'string') {
            if (this.requests.size >= 64) {
                this.close('Too many pending native requests')
                return
            }
            const request = { id: message.id, method, params: message.params }
            this.requests.set(String(message.id), request)
            this.emit({ method: 'hapi/request', params: request })
            return
        }
        if (method === 'serverRequest/resolved') {
            const id = record(message.params).requestId
            this.requests.delete(String(id))
            this.emit({ method: 'hapi/requestResolved', params: { id } })
        }
        this.emit({ method, params: message.params })
    }
    private rawRequest(method: string, params: unknown): Promise<unknown> {
        if (this.disposed || this.socket?.readyState !== WebSocket.OPEN)
            return Promise.reject(new Error('Native connection unavailable'))
        if (this.pending.size >= 64)
            return Promise.reject(new Error('Native request limit reached'))
        const id = ++this.sequence
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error('Native request timed out; mutation outcome may be unknown'))
            }, method === 'thread/sample' ? 120_000 : 20_000)
            this.pending.set(id, { resolve, reject, timer })
            this.socket!.send(JSON.stringify({ id, method, params }), (error) => {
                if (!error) return
                const pending = this.pending.get(id)
                this.pending.delete(id)
                clearTimeout(timer)
                pending?.reject(error)
            })
        })
    }
    async request(method: string, params: unknown): Promise<unknown> {
        await this.connect()
        return this.rawRequest(method, params)
    }
    reply(id: string, threadId: string, response: { result?: unknown; error?: unknown }): void {
        const request = this.requests.get(id)
        if (!request || record(request.params).threadId !== threadId)
            throw new Error('Native request is no longer pending')
        if (this.socket?.readyState !== WebSocket.OPEN)
            throw new Error('Native connection unavailable')
        this.socket.send(JSON.stringify({ id: request.id, ...response }))
        // Only the daemon's serverRequest/resolved event establishes resolution.
    }
    close(reason = 'Native connection released'): void {
        if (this.disposed) return
        this.disposed = true
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error(reason))
        }
        this.pending.clear()
        this.requests.clear()
        this.socket?.terminate()
        this.emit({ method: 'hapi/disconnected', params: { error: reason } })
        this.listeners.clear()
    }
}
