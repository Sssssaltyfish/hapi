import { describe, expect, it, vi } from 'vitest'
import { HistoryPageCache, HistoryScrollPrefetch } from './history-page-cache'

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

describe('history scroll look-ahead', () => {
    it('responds to the first fast movement and rebases after a prepend without reversing intent', () => {
        const prefetch = new HistoryScrollPrefetch()
        prefetch.beginGesture(3600, 10000, 600, 0)
        expect(prefetch.sample(3200, 10000, 600, 16)).toEqual({ direction: 'older', pages: 4 })
        expect(prefetch.loadMargin('older', 600, 16)).toBe(1200)
        expect(prefetch.sample(6200, 13000, 600, 32)).toBeNull()
        expect(prefetch.loadMargin('newer', 600, 32)).toBe(200)
        expect(prefetch.sample(2800, 13000, 600, 48)).toEqual({ direction: 'older', pages: 4 })
    })

    it('gives slow pages more lead time without losing the estimate on a cache hit', () => {
        const prefetch = new HistoryScrollPrefetch()
        prefetch.beginGesture(2400, 10000, 600, 0)
        prefetch.sample(2300, 10000, 600, 100)
        const before = prefetch.loadMargin('older', 600, 100)
        prefetch.recordLoad(900)
        expect(prefetch.loadMargin('older', 600, 100)).toBeGreaterThan(before)
        prefetch.recordLoad(1)
        expect(prefetch.loadMargin('older', 600, 100)).toBeGreaterThan(before)
        expect(prefetch.sample(1900, 10000, 600, 400)).toEqual({ direction: 'older', pages: 2 })
    })

    it('drops the old fling speed on reversal and falls back to the ordinary edge after stopping', () => {
        const prefetch = new HistoryScrollPrefetch()
        prefetch.beginGesture(1000, 3000, 600, 0)
        prefetch.sample(600, 3000, 600, 16)
        prefetch.sample(603, 3000, 600, 32)
        expect(prefetch.loadMargin('older', 600, 32)).toBe(200)
        expect(prefetch.loadMargin('newer', 600, 32)).toBe(200)
        prefetch.sample(1200, 3000, 600, 48)
        expect(prefetch.loadMargin('newer', 600, 2000)).toBe(200)
    })
})
