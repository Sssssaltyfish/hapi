import { describe, expect, it, spyOn } from 'bun:test'
import { nativeOutlinePage } from './conversationOutline'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'
import { RpcRegistry } from '../socket/rpcRegistry'

const user = (id: string, type = 'userMessage', status?: string) => ({ item: { id, type, status, content: [{ type: 'text', text: `prompt ${id}` }] }, startedAtMs: 100 })
const turn = (id: string, items = [user(id).item]) => ({ id: `turn-${id}`, items, itemsView: 'summary', startedAt: 1 })

describe('user-only conversation outline', () => {
    it('indexes initial summary users with separate turn continuation and body targets', async () => {
        const cursors: unknown[] = []
        const page = await nativeOutlinePage(async params => {
            cursors.push(params.cursor)
            expect(params.itemsView).toBe('summary')
            if (!params.cursor) return { data: [turn('current', [user('current').item, user('steer', 'steeringUserMessage', 'accepted').item])], nextCursor: 'opaque / older?+cursor' }
            const first = user('first')
            first.item.content = [{ type: 'text', text: '<send_user_message_question_reply>{"questionItemId":"q1","question":"Choose a folder","answer":"Existing workspace"}</send_user_message_question_reply>' }]
            return { data: [turn('first', [first.item])], nextCursor: null }
        }, null)
        expect(cursors).toEqual([undefined, 'opaque / older?+cursor'])
        expect(page.items.map(item => item.targetMessageId)).toEqual(['user-text:native:current', 'user-text:native:first'])
        expect(page.items[1].indexPage).toEqual({ kind: 'native-turns', cursor: 'opaque / older?+cursor' })
        expect(page.items[1].nativeTurn).toEqual({ turnId: 'turn-first', itemId: 'first' })
        expect(page.items[1].historyPage).toBeUndefined()
        expect(page.items[1].label).toBe('Choose a folder Existing workspace')
        expect(JSON.stringify(page)).not.toContain('private tool body')
        expect(page.next).toBeNull()
    })

    it('bounds each native scan even when every page finds a prompt, and returns the unchanged continuation', async () => {
        let calls = 0
        const page = await nativeOutlinePage(async () => ({ data: [turn(String(++calls))], nextCursor: `opaque-${calls}` }), null)
        expect(calls).toBe(4)
        expect(page.items).toHaveLength(4)
        expect(page.next).toEqual({ kind: 'native-turns', cursor: 'opaque-4' })
    })

    it('uses only a validated UUIDv7 clock or native completion time when the start time is unknown', async () => {
        const page = await nativeOutlinePage(async () => ({
            data: [
                { ...turn('v7'), id: '00000000-03e8-7000-8000-000000000000', startedAt: null, completedAt: 10 },
                { ...turn('v4'), id: '00000000-03e8-4000-8000-000000000000', startedAt: null, completedAt: 20 },
                { ...turn('unknown'), startedAt: null, completedAt: null }
            ], nextCursor: null
        }), null)
        expect(page.items.map(item => item.createdAt)).toEqual([1000, 20_000, 0])
    })

    it('finishes a page that crosses the scan time budget and returns all progress without starting another page', async () => {
        let now = 0
        const clock = spyOn(Date, 'now').mockImplementation(() => now)
        let calls = 0
        try {
            const page = await nativeOutlinePage(async (...args) => {
                expect(args).toHaveLength(1)
                calls++
                // Page two starts with 100 ms of scan budget remaining but
                // finishes 200 ms later under its ordinary RPC timeout.
                now = calls === 1 ? 1400 : 1600
                return { data: [turn(String(calls))], nextCursor: `after-${calls}` }
            }, null)
            expect(calls).toBe(2)
            expect(page.items.map(item => item.label)).toEqual(['prompt 1', 'prompt 2'])
            expect(page.next).toEqual({ kind: 'native-turns', cursor: 'after-2' })
        } finally {
            clock.mockRestore()
        }
    })

    it('stops at the first surviving cached user boundary after an offline rewind', async () => {
        const page = await nativeOutlinePage(async () => ({ data: [turn('new'), turn('A3'), turn('A2')], nextCursor: 'actual-next' }), null,
            ['user-text:native:A5', 'user-text:native:A4', 'user-text:native:A3'])
        expect(page.overlapId).toBe('user-text:native:A3')
        expect(page.items.map(item => item.label)).toEqual(['prompt new', 'prompt A3'])
        expect(page.reachedHead).toBe(true)
        expect(page.next).toBeNull()
    })

    it('projects stored Runner user input through tool-heavy pages, excluding pending messages and detecting reset epochs', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('outline-store', { path: '/tmp', host: 'test', flavor: 'claude' }, {}, 'default')
            const old = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'older prompt' } })
            for (let i = 0; i < 220; i++) store.messages.addMessage(session.id, { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'tool noise' }] } } } })
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'new prompt' } })
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'still queued' } }, 'pending')
            const page = engine.getConversationOutline(session.id, { kind: 'runner', beforeAt: null, beforeSeq: null, epoch: null })
            expect(page.items.map(item => item.label)).toEqual(['new prompt', 'older prompt'])
            expect(page.items[1].targetMessageId).toBe(`user-text:${old.id}`)
            expect(page.scanned).toBe(3)
            expect(JSON.stringify(page)).not.toContain('tool noise')
            store.messages.bumpMessageEpoch(session.id)
            const reset = engine.getConversationOutline(session.id, { kind: 'runner', beforeAt: null, beforeSeq: null, epoch: page.epoch })
            expect(reset.epoch).not.toBe(page.epoch)
            expect(reset.items).toEqual([])
        } finally { engine.stop(); store.close() }
    })
})
