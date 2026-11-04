import { describe, expect, it } from 'bun:test'
import { nativeTurnContext } from './turnContext'
import type { NativeRecord } from './transport'

const entry = (id: string, turnId = 'turn') => ({ item: { id, type: 'userMessage' }, turnId })

describe('Native turn body context', () => {
    it('uses a scoped anchor only to obtain real global cursors and merges both neighboring directions', async () => {
        const requests: NativeRecord[] = []
        const result = await nativeTurnContext(async params => {
            requests.push(params)
            if (requests.length === 1) return { data: [entry('following')], backwardsCursor: 'global-desc-seed' }
            if (requests.length === 2) return { data: [entry('following'), entry('target'), entry('older', 'older-turn')], nextCursor: 'global-older', backwardsCursor: 'global-asc-seed' }
            return { data: [entry('following'), entry('newer', 'newer-turn')], nextCursor: 'global-newer' }
        }, 'turn', 'target')
        expect(requests).toEqual([
            { turnId: 'turn', cursor: { type: 'item', itemId: 'target' }, sortDirection: 'asc', limit: 1 },
            { cursor: 'global-desc-seed', sortDirection: 'desc', limit: 50 },
            { cursor: 'global-asc-seed', sortDirection: 'asc', limit: 50 }
        ])
        expect(result.data.map(value => (value.item as NativeRecord).id)).toEqual(['newer', 'following', 'target', 'older'])
        expect(result.nextCursor).toBe('global-older')
        expect(result.backwardsCursor).toBe('global-newer')
        expect(result.newerResumeCursor).toBe('global-asc-seed')
    })

    it('validates a user-only turn before using its last-item cursor and retains the real tail resume seed', async () => {
        const requests: NativeRecord[] = []
        const result = await nativeTurnContext(async params => {
            requests.push(params)
            if (requests.length === 1) return { data: [] }
            if (requests.length === 2) return { data: [entry('target')], backwardsCursor: 'global-asc-seed' }
            if (requests.length === 3) return { data: [entry('target'), entry('next-user', 'next-turn')], backwardsCursor: 'global-desc-seed', nextCursor: null }
            return { data: [entry('target'), entry('older', 'older-turn')], nextCursor: 'global-older' }
        }, 'turn', 'target')
        expect(requests[1]).toEqual({ turnId: 'turn', sortDirection: 'desc', limit: 1 })
        expect(requests.slice(2).every(params => !('turnId' in params))).toBe(true)
        expect(result.data.map(value => (value.item as NativeRecord).id)).toEqual(['next-user', 'target', 'older'])
        expect(result.nextCursor).toBe('global-older')
        expect(result.backwardsCursor).toBeNull()
        expect(result.newerResumeCursor).toBe('global-asc-seed')
    })

    it('does not present a global window that lost the selected target', async () => {
        let calls = 0
        await expect(nativeTurnContext(async () => ++calls === 1
            ? { data: [entry('following')], backwardsCursor: 'global-desc-seed' }
            : { data: [entry('following')], nextCursor: null, backwardsCursor: null }, 'turn', 'missing'))
            .rejects.toThrow('no longer available')
    })

    it('does not claim a usable context when no genuine forward resume cursor is available', async () => {
        let calls = 0
        await expect(nativeTurnContext(async () => ++calls === 1
            ? { data: [entry('following')], backwardsCursor: 'global-desc-seed' }
            : { data: [entry('following'), entry('target')], nextCursor: 'older', backwardsCursor: null }, 'turn', 'target'))
            .rejects.toThrow('forward cursor')
        expect(calls).toBe(2)
    })
})
