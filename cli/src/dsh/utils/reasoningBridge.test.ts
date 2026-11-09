import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DSH_REASONING_SNAPSHOT_META } from '@/agent/backends/acp/constants'
import { DSH_REASONING_BRIDGE_SOURCE } from './reasoningBridge'

type Update = {
    sessionUpdate: string
    messageId?: string
    content?: { type: string; text: string }
    _meta?: Record<string, unknown>
}
type Notification = { params: { sessionId: string; update: Update } }
type ReasoningBridge = {
    frame(sessionId: string, frame: unknown, canPreview: boolean): void
    event(session: { id: string }, event: unknown): void
    update(sessionId: string, update: Update): Update
    pause(sessionId: string): void
    clear(sessionId: string): void
}
type CreateBridge = (
    send: (message: Notification) => Promise<void>,
    warn: (text: string) => void,
    newId: () => string,
    metaKey: string,
    snapshotInterval: number,
) => ReasoningBridge

// Exercise the JavaScript that the installed Node-based DSH loads from disk.
const createBridge: CreateBridge = new Function(DSH_REASONING_BRIDGE_SOURCE + '\nreturn createReasoningBridge')()
const session = { id: 'session' }
const meta = DSH_REASONING_SNAPSHOT_META
const start = (attemptId: string, step = 1) => ({ type: 'start', attemptId, turn: 1, step })
const delta = (attemptId: string, text: string, index = 0) => ({
    type: 'chunk', attemptId, chunk: { type: 'reasoning-delta', index, text }
})
const end = (attemptId: string, eventType: string, seq = 20) => ({
    type: 'end', attemptId, outcome: { kind: 'committed', eventType, seq }
})
const canonical = (id: string, blocks: string[], step = 1, seq = 20, interrupted = false) => ({
    type: 'assistant/message', seq, data: {
        turn: 1, step, interrupted,
        message: { id, content: blocks.map(text => ({ type: 'reasoning', text })) }
    }
})
const thought = (messageId: string, text: string): Update => ({
    sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text }
})

describe('DSH reasoning bridge', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    function setup() {
        const updates: Update[] = []
        let nextId = 0
        const bridge = createBridge(async message => { updates.push(message.params.update) },
            () => {}, () => 'preview-' + ++nextId, meta, 250)
        const frame = (value: unknown, canPreview = true) => bridge.frame(session.id, value, canPreview)
        return { bridge, updates, frame }
    }

    it('sends growing previews while the provider pauses and replaces them with the canonical thought', () => {
        const { bridge, updates, frame } = setup()
        frame(start('a'))
        frame(delta('a', 'First'))
        vi.advanceTimersByTime(249)
        expect(updates).toEqual([])
        vi.advanceTimersByTime(1)
        frame(delta('a', ' second'))
        frame(delta('a', ' third'))
        vi.advanceTimersByTime(250)
        expect(updates.map(update => [update.content?.text, update._meta?.[meta]])).toEqual([
            ['First', { id: 'preview-1', live: true }],
            ['First second third', { id: 'preview-1', live: true }]
        ])

        frame({ type: 'chunk', attemptId: 'a', chunk: {
            type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Canonical revision' }
        } })
        bridge.event(session, canonical('message', ['Canonical revision']))
        frame(end('a', 'assistant/message'))
        const final = thought('message', 'Canonical revision')
        expect(bridge.update('another-session', final)).toBe(final)
        expect(bridge.update(session.id, final)).toEqual({
            ...final, _meta: { [meta]: { id: 'preview-1', live: false } }
        })
        bridge.clear(session.id)
        vi.advanceTimersByTime(1000)
        expect(updates).toHaveLength(2)
    })

    it('settles only the published preview on a failed attempt and gives a retry its own identity', () => {
        const { bridge, updates, frame } = setup()
        frame(start('failed'))
        frame(delta('failed', 'Visible first attempt'))
        vi.advanceTimersByTime(250)
        frame(delta('failed', ' unpublished tail'))
        frame(end('failed', 'assistant/attempt'))
        frame(start('retry'))
        frame(delta('retry', 'Retry reasoning'))
        frame(delta('failed', ' stale'))
        vi.advanceTimersByTime(250)
        expect(updates.map(update => [update.content?.text, update._meta?.[meta]])).toEqual([
            ['Visible first attempt', { id: 'preview-1', live: true }],
            ['Visible first attempt', { id: 'preview-1', live: false }],
            ['Retry reasoning', { id: 'preview-2', live: true }]
        ])
        bridge.event(session, canonical('retry-message', ['Retry reasoning']))
        frame(end('retry', 'assistant/message'))
        expect(bridge.update(session.id, thought('retry-message', 'Retry reasoning'))._meta?.[meta])
            .toEqual({ id: 'preview-2', live: false })
    })

    it('stops previews at cancellation and settles interrupted canonical blocks in order', () => {
        const { bridge, updates, frame } = setup()
        frame(start('a'))
        frame(delta('a', ' ', 0))
        frame(delta('a', 'One', 1))
        frame(delta('a', 'Two', 2))
        vi.advanceTimersByTime(250)
        frame(delta('a', ' continued', 2))
        bridge.pause(session.id)
        frame(delta('a', ' after cancel', 1), false)
        vi.advanceTimersByTime(1000)
        expect(updates.map(update => update.content?.text)).toEqual(['One', 'Two'])
        bridge.event(session, canonical('cancelled', ['One after cancel', 'Two continued'], 1, 20, true))
        frame(end('a', 'assistant/message'), false)
        const tool = { sessionUpdate: 'tool_call', messageId: 'cancelled' }
        expect(bridge.update(session.id, tool)).toBe(tool)
        expect(bridge.update(session.id, thought('cancelled', 'One after cancel'))._meta?.[meta])
            .toEqual({ id: 'preview-2', live: false })
        expect(bridge.update(session.id, thought('cancelled', 'Two continued'))._meta?.[meta])
            .toEqual({ id: 'preview-3', live: false })
        bridge.clear(session.id)
        expect(updates).toHaveLength(2)
    })

    it('leaves fast and replayed thought updates on the original path', () => {
        const { bridge, updates, frame } = setup()
        frame(start('a'))
        frame(delta('a', 'Fast'))
        bridge.event(session, canonical('message', ['Fast']))
        frame(end('a', 'assistant/message'))
        const final = thought('message', 'Fast')
        expect(bridge.update(session.id, final)).toBe(final)

        frame(start('replay'), false)
        frame(delta('replay', 'Previously committed'), false)
        vi.advanceTimersByTime(1000)
        expect(updates).toEqual([])
    })
})
