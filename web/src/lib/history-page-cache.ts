export type HistoryDirection = 'older' | 'newer'

/** Short-lived transport pages, separate from the rendered message window. */
export class HistoryPageCache<T> {
    private pages = new Map<string, {
        value: T
        items: number
        bytes: number
        expires: number
        scope: string
    }>()
    private pending = new Map<string, {
        promise: Promise<T>
        controller: AbortController
        scope: string
    }>()
    private active = 0
    private waiting: Array<() => void> = []

    constructor(private readonly budget: {
        items: number
        bytes: number
        ttlMs?: number
    }) {}

    clear(scope?: string): void {
        for (const [key, page] of this.pages) {
            if (scope === undefined || page.scope === scope) {
                this.pages.delete(key)
            }
        }
        for (const [key, pending] of this.pending) {
            if (scope !== undefined && pending.scope !== scope) {
                continue
            }
            this.pending.delete(key)
            pending.controller.abort()
        }
    }

    async read(
        key: string,
        load: (signal: AbortSignal) => Promise<T>,
        size: (value: T) => number,
        retain: (value: T) => boolean = () => true,
        valid: (value: T) => boolean = () => true,
        scope = ''
    ): Promise<T> {
        const cached = this.pages.get(key)
        if (cached && cached.expires > Date.now() && valid(cached.value)) {
            this.pages.delete(key)
            this.pages.set(key, cached)
            return cached.value
        }
        this.pages.delete(key)
        const pending = this.pending.get(key)
        if (pending) {
            return pending.promise
        }
        const controller = new AbortController()
        const request = this.run(load, controller.signal).then(value => {
            if (!controller.signal.aborted && this.pending.get(key)?.promise === request && retain(value)) {
                const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
                const items = size(value)
                if (items <= this.budget.items && bytes <= this.budget.bytes) {
                    this.pages.set(key, { value, items, bytes, expires: Date.now() + (this.budget.ttlMs ?? 30_000), scope })
                    this.trim()
                }
            }
            return value
        }).finally(() => {
            if (this.pending.get(key)?.promise === request) {
                this.pending.delete(key)
            }
        })
        this.pending.set(key, { promise: request, controller, scope })
        return request
    }

    private async run(load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
        if (this.active >= 2) {
            await new Promise<void>((resolve, reject) => {
                const grant = () => {
                    signal.removeEventListener('abort', cancel)
                    resolve()
                }
                const cancel = () => {
                    this.waiting = this.waiting.filter(waiter => waiter !== grant)
                    reject(new Error('History page request invalidated'))
                }
                signal.addEventListener('abort', cancel, { once: true })
                this.waiting.push(grant)
            })
        } else {
            this.active += 1
        }
        try {
            if (signal.aborted) {
                throw new Error('History page request invalidated')
            }
            // Release the slot on cancellation even if a transport/mock does
            // not settle its aborted promise. Its later result has no owner.
            return await new Promise<T>((resolve, reject) => {
                const cancel = () => reject(new Error('History page request invalidated'))
                signal.addEventListener('abort', cancel, { once: true })
                try {
                    load(signal).then(value => {
                        signal.removeEventListener('abort', cancel)
                        resolve(value)
                    }, error => {
                        signal.removeEventListener('abort', cancel)
                        reject(error)
                    })
                } catch (error) {
                    signal.removeEventListener('abort', cancel)
                    reject(error)
                }
            })
        } finally {
            const next = this.waiting.shift()
            if (next) {
                next()
            } else {
                this.active -= 1
            }
        }
    }

    private trim(): void {
        let items = 0
        let bytes = 0
        const now = Date.now()
        for (const [key, page] of this.pages) {
            if (page.expires <= now) {
                this.pages.delete(key)
            } else {
                items += page.items
                bytes += page.bytes
            }
        }
        if (items <= this.budget.items && bytes <= this.budget.bytes && this.pages.size <= 48) {
            return
        }
        // Reclaim a reserve at once, rather than evicting one page on every
        // alternating boundary read. Recently used pages stay at the MRU end.
        for (const [key, page] of this.pages) {
            this.pages.delete(key)
            items -= page.items
            bytes -= page.bytes
            if (items <= this.budget.items * 0.75 && bytes <= this.budget.bytes * 0.75 && this.pages.size <= 36) {
                break
            }
        }
    }
}

/** A bounded look-ahead horizon, sampled only during reader-driven scrolling. */
export class HistoryScrollPrefetch {
    private previous: {
        top: number
        time: number
    } | null = null
    private speed = 0

    sample(top: number, height: number, viewport: number, now: number): {
        direction: HistoryDirection
        pages: number
    } | null {
        const previous = this.previous
        this.previous = { top, time: now }
        if (!previous || now <= previous.time || now - previous.time > 400) {
            this.speed = 0
            return null
        }
        if (Math.abs(top - previous.top) < 2) {
            return null
        }
        const delta = top - previous.top
        this.speed = this.speed * 0.4 + Math.abs(delta) / Math.max(16, now - previous.time) * 0.6
        const horizon = Math.min(viewport * 4, Math.max(viewport, this.speed * 650))
        const direction = delta < 0 ? 'older' : 'newer'
        const distance = direction === 'older' ? top : height - top - viewport
        return distance <= horizon ? { direction, pages: this.speed >= 1 ? 2 : 1 } : null
    }
}
