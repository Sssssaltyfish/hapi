import { describe, expect, it } from 'vitest'
import type { AgentTextBlock, UserTextBlock } from '@/chat/types'
import { buildMaterializedTimelineRows, getMessagePartScrollAnchors } from './assistant-runtime'
import { StableChatTimeline, type TimelineHistoryLocator } from './stable-chat-timeline'

function text(id: string, createdAt: number, extra: Partial<AgentTextBlock> = {}): AgentTextBlock {
    return { kind: 'agent-text', id, localId: null, createdAt, text: id, ...extra }
}

function user(id: string, createdAt: number, extra: Partial<UserTextBlock> = {}): UserTextBlock {
    return { kind: 'user-text', id, localId: null, createdAt, text: id, ...extra }
}

function contents(message: { content?: unknown }): string[] {
    return (message.content as Array<{ text: string }>).map(part => part.text)
}

describe('stable logical chat timeline', () => {
    it('replaces disjoint history segments instead of implying adjacency across an unread seek gap', () => {
        const timeline = new StableChatTimeline()
        const latest = text('latest', 100)
        const older = text('older', 1)
        const pending = user('pending', 200, { status: 'sending', localId: 'request' })
        const latestLocator: TimelineHistoryLocator = { kind: 'native', turnId: 'new-turn', itemId: 'latest' }
        const olderLocator: TimelineHistoryLocator = { kind: 'native', turnId: 'old-turn', itemId: 'older' }
        const locators = new Map([['latest', latestLocator], ['older', olderLocator]])
        timeline.update(buildMaterializedTimelineRows([latest, pending]), locators)
        timeline.pinTimelineRows(['latest'])
        const sought = timeline.update(buildMaterializedTimelineRows([older, pending]), locators)
        expect(timeline.getRows().map(row => row.id)).toEqual(['agent-text:older', 'user-text:pending'])
        expect(sought.map(row => row.message.id)).toEqual(['agent-text:older', 'user-text:pending'])
        expect(timeline.resolveRowId('latest')).toBeNull()
        expect(timeline.getRowSnapshot('latest')).toBeNull()
    })

    it('preserves locator-backed row identity across overlapping pages and known-row rehydration', () => {
        const timeline = new StableChatTimeline(0)
        const earlier = user('earlier', 1)
        const response = text('response', 2)
        const next = user('next', 3)
        const locator = (itemId: string): TimelineHistoryLocator => ({ kind: 'native', turnId: 'turn', itemId })
        const locators = new Map(['earlier', 'response', 'next'].map(id => [id, locator(id)]))
        const initial = timeline.update(buildMaterializedTimelineRows([earlier, response]), locators)
        const id = initial[1].message.id
        timeline.update(buildMaterializedTimelineRows([response, next]), locators)
        timeline.update(buildMaterializedTimelineRows([next]), locators)
        expect(timeline.getRows()).toHaveLength(3)
        expect(timeline.getRows()[1]).toMatchObject({ id, resident: false })
        const rehydrated = timeline.update(buildMaterializedTimelineRows([response]), locators)
        expect(timeline.getRows().map(row => row.id)).toEqual(['user-text:earlier', id, 'user-text:next'])
        expect(rehydrated[0].message.id).toBe(id)
    })

    it('retains the first observed response identity when an earlier part is prepended or the source prefix is trimmed', () => {
        const timeline = new StableChatTimeline()
        const a = text('a', 10)
        const b = text('b', 20)
        const c = text('c', 30)
        const initial = timeline.update(buildMaterializedTimelineRows([b, c]))
        const id = initial[0].message.id
        const prepended = timeline.update(buildMaterializedTimelineRows([a, b, c]))
        expect(prepended[0].message.id).toBe(id)
        expect(contents(prepended[0].message)).toEqual(['a', 'b', 'c'])
        const trimmed = timeline.update(buildMaterializedTimelineRows([c]))
        expect(trimmed[0]).toBe(prepended[0])
        expect(contents(trimmed[0].message)).toEqual(['a', 'b', 'c'])
        expect(timeline.resolveRowId('agent-text:a')).toBe(id)
        expect(getMessagePartScrollAnchors(trimmed[0].message.content![1] as never)).toEqual(['agent-text:b'])
    })

    it('reuses completed row projections while explicitly invalidating only changed metadata', () => {
        const timeline = new StableChatTimeline()
        const u = user('u', 10)
        const a = text('a', 20, { localId: 'turn-a', usage: { input_tokens: 1, output_tokens: 2 } })
        const b = text('b', 21, { localId: 'turn-b', usage: { input_tokens: 3, output_tokens: 4 } })
        const initial = timeline.update(buildMaterializedTimelineRows([u, a, b]))
        const changed = timeline.update(buildMaterializedTimelineRows([user('older', 1), u, a, b]))
        expect(changed[1]).toBe(initial[0])
        expect(changed[2]).toBe(initial[1])
        const updated = timeline.update(buildMaterializedTimelineRows([u, a, { ...b, usage: { input_tokens: 30, output_tokens: 40 } }]))
        expect(updated[1]).toBe(initial[0])
        expect(updated[2]).not.toBe(initial[1])
        expect(updated[2].message.metadata?.custom?.usage).toEqual({
            input_tokens: 31, output_tokens: 42,
        })
    })

    it('preserves logical order and locators after byte eviction and rehydrates the same rows', () => {
        const timeline = new StableChatTimeline(0)
        const u = user('u', 10)
        const a = text('a', 20)
        const locator: TimelineHistoryLocator = { kind: 'native', turnId: 'turn', itemId: 'a' }
        timeline.update(buildMaterializedTimelineRows([u, a]), new Map([['a', locator]]))
        const ids = timeline.getRows().map(row => row.id)
        const later = user('later', 30)
        timeline.update(buildMaterializedTimelineRows([later]))
        expect(timeline.getRows().map(row => row.id)).toEqual([...ids, 'user-text:later'])
        expect(timeline.getRows()[1]).toMatchObject({ id: ids[1], resident: false, current: false, locator })
        expect(timeline.getRowSnapshot('a')).toBeNull()
        timeline.update(buildMaterializedTimelineRows([u, a]))
        expect(timeline.getRows()[1]).toMatchObject({ id: ids[1], resident: true, current: true })
        expect(timeline.getRowSnapshot('a')?.text).toBe('a')
    })

    it('keeps a known response nonresident until all its evicted pieces have been restored', () => {
        const timeline = new StableChatTimeline(0)
        const a = text('a', 10)
        const b = text('b', 20)
        const locatorA: TimelineHistoryLocator = { kind: 'native', turnId: 't', itemId: 'a' }
        const locatorB: TimelineHistoryLocator = { kind: 'native', turnId: 't', itemId: 'b' }
        timeline.update(buildMaterializedTimelineRows([a, b]), new Map([['a', locatorA], ['b', locatorB]]))
        timeline.update(buildMaterializedTimelineRows([user('later', 30)]))
        expect(timeline.update(buildMaterializedTimelineRows([b]))).toHaveLength(0)
        expect(timeline.getRows()[0]).toMatchObject({ resident: false, locator: locatorA })
        const restored = timeline.update(buildMaterializedTimelineRows([a]))
        expect(contents(restored[0].message)).toEqual(['a', 'b'])
        expect(timeline.getRows()[0].resident).toBe(true)
    })

    it('preserves both cached fragments when a contiguous page proves they form one response', () => {
        const timeline = new StableChatTimeline()
        const a = text('a', 1)
        const b = text('b', 2)
        const c = text('c', 3)
        const d = text('d', 4)
        timeline.update(buildMaterializedTimelineRows([c, d]))
        const originalId = timeline.getRows()[0].id
        timeline.update(buildMaterializedTimelineRows([a, b]))
        expect(timeline.getRows()).toHaveLength(2)
        const combined = timeline.update(buildMaterializedTimelineRows([b, c]))
        expect(timeline.getRows()).toHaveLength(1)
        expect(combined[0].message.id).toBe(originalId)
        expect(contents(combined[0].message)).toEqual(['a', 'b', 'c', 'd'])
        expect(timeline.resolveRowId('agent-text:a')).toBe(originalId)
    })

    it('pins only the requested viewport neighborhood through later source-window updates', () => {
        const timeline = new StableChatTimeline(0)
        timeline.update(buildMaterializedTimelineRows([user('first', 1), text('reply', 2)]))
        timeline.pinTimelineRows(['reply'])
        timeline.update(buildMaterializedTimelineRows([user('latest', 3)]))
        expect(timeline.getRows().map(row => row.resident)).toEqual([false, true, true])
        timeline.pinTimelineRows([])
        timeline.update(buildMaterializedTimelineRows([user('latest', 3)]))
        expect(timeline.getRows().map(row => row.resident)).toEqual([false, false, true])
    })

    it('never joins disconnected assistant segments by timestamp, and preserves user boundaries', () => {
        const timeline = new StableChatTimeline()
        const a = text('a', 10)
        const b = text('b', 11)
        timeline.update(buildMaterializedTimelineRows([a]))
        timeline.update(buildMaterializedTimelineRows([b]))
        expect(timeline.getRows()).toHaveLength(2)
        timeline.update(buildMaterializedTimelineRows([a, user('u', 10.5), b]))
        expect(timeline.getRows().map(row => row.id)).toEqual(['agent-text:a', 'user-text:u', 'agent-text:b'])
    })

    it('removes absent optimistic rows and retains the user identity after server acknowledgement', () => {
        const timeline = new StableChatTimeline()
        timeline.update(buildMaterializedTimelineRows([user('optimistic', 1, { status: 'sending', localId: 'local' })]))
        const id = timeline.getRows()[0].id
        timeline.update(buildMaterializedTimelineRows([user('server', 1, { status: 'sent', localId: 'local' })]))
        expect(timeline.getRows()[0].id).toBe(id)
        timeline.update(buildMaterializedTimelineRows([user('failed', 2, { status: 'failed' })]))
        timeline.update([])
        expect(timeline.resolveRowId('failed')).toBeNull()
        expect(timeline.resolveRowId('server')).toBe(id)
    })
})
