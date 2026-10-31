import { describe, expect, it, vi } from 'vitest'
import { HistoryPageCache } from './history-page-cache'

describe('neighboring history pages', () => {
    it('keeps a recently revisited page while reclaiming a bounded reserve', async () => {
        const cache = new HistoryPageCache<number[]>({ items: 6, bytes: 1000 })
        const load = vi.fn(async () => [1, 2])
        const read = (key: string) => cache.read(key, load, page => page.length)
        await read('a'); await read('b'); await read('c')
        await read('a')
        await read('d')
        expect(load).toHaveBeenCalledTimes(4)
        await read('a')
        expect(load).toHaveBeenCalledTimes(4)
        await read('b')
        expect(load).toHaveBeenCalledTimes(5)
    })

    it('aborts a previous scope, frees occupied slots, and never starts its queued prefetch', async () => {
        const cache = new HistoryPageCache<number[]>({ items: 10, bytes: 1000 })
        const signals: AbortSignal[] = []
        const complete: Array<() => void> = []
        const load = vi.fn((signal: AbortSignal) => {
            signals.push(signal)
            // Deliberately leave the transport pending even after abort.
            return new Promise<number[]>(resolve => complete.push(() => resolve([1])))
        })
        const first = cache.read('a', load, page => page.length, undefined, undefined, 'old')
        const second = cache.read('b', load, page => page.length, undefined, undefined, 'old')
        const third = cache.read('c', load, page => page.length, undefined, undefined, 'old')
        const stopped = Promise.allSettled([first, second, third])
        expect(load).toHaveBeenCalledTimes(2)
        cache.clear('old')
        expect(signals.every(signal => signal.aborted)).toBe(true)
        expect((await stopped).every(result => result.status === 'rejected')).toBe(true)
        expect(load).toHaveBeenCalledTimes(2)
        const fresh = vi.fn(async () => [2])
        expect(await cache.read('a', fresh, page => page.length, undefined, undefined, 'new')).toEqual([2])
        complete.forEach(done => done())
        await Promise.resolve()
        expect(await cache.read('a', fresh, page => page.length, undefined, undefined, 'new')).toEqual([2])
        expect(fresh).toHaveBeenCalledOnce()
    })
})
