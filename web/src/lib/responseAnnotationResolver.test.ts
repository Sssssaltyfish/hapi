import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'
import { projectNativeItems } from '@/codex-native/projectNativeItems'
import { ResponseAnnotationResolver } from './responseAnnotationResolver'
import { serializeResponseAnnotations } from './responseAnnotations'

const native = { id: 'session', metadata: { nativeCodex: { threadId: 'thread', endpointId: 'endpoint' } } } as Session
const runner = { id: 'runner', metadata: { flavor: 'codex' } } as Session
const selections = [{ text: 'original', annotation: 'explain', source: { messageId: 'old-source', startOffset: 0, endOffset: 8 } }]
function raw(id: string, seq: number, role: 'user' | 'agent', text: string): DecryptedMessage {
    return { id, seq, createdAt: seq, localId: null, content: role === 'user' ? { role, content: { type: 'text', text } }
        : { role, content: { type: 'codex', data: { type: 'message', message: text } } } } as DecryptedMessage
}
function page(messages: DecryptedMessage[], hasMore = false) {
    return { messages, page: { hasMore, nextBeforeAt: messages[0]?.createdAt ?? null, nextBeforeSeq: messages[0]?.seq ?? null, epoch: 1 } }
}
describe('durable response annotation resolution', () => {
    it('reads the prompt owning a native reply outside the raw window and reuses it', async () => {
        const getCodexNativeTurnItems = vi.fn().mockResolvedValue({ data: [{ turnId: 'turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: serializeResponseAnnotations('question', selections) }] } }], nextCursor: null })
        const api = { getCodexNativeTurnItems } as unknown as ApiClient
        const resolver = new ResponseAnnotationResolver(api, native)
        resolver.observe(projectNativeItems([{ turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'reply :codex-annotation{index="1"}' } }], []).messages)
        const id = 'agent-text:native:answer'
        expect(await resolver.readAnnotations(id)).toEqual(selections)
        expect(await resolver.readAnnotations(id)).toEqual(selections)
        expect(getCodexNativeTurnItems).toHaveBeenCalledTimes(1)
        expect(getCodexNativeTurnItems).toHaveBeenCalledWith('thread', 'turn', expect.objectContaining({ cursor: { type: 'item', itemId: 'answer' }, sortDirection: 'desc' }))
    })

    it('shares a legacy native item index scan and uses durable exact item reads for both jumps', async () => {
        let release!: (value: unknown) => void
        const getCodexNativeItems = vi.fn().mockReturnValue(new Promise(resolve => { release = resolve }))
        const getCodexNativeItem = vi.fn(async (_thread, turnId, itemId) => ({ entry: { turnId, item: { id: itemId, type: 'agentMessage', text: 'original' } } }))
        const resolver = new ResponseAnnotationResolver({ getCodexNativeItems, getCodexNativeItem } as unknown as ApiClient, native)
        const one = resolver.resolve(selections[0])
        const two = resolver.resolve({ ...selections[0], source: { ...selections[0].source, messageId: 'another' } })
        expect(getCodexNativeItems).toHaveBeenCalledTimes(1)
        release({ data: [{ turnId: 'old-turn', item: { id: 'old-source' } }, { turnId: 'other-turn', item: { id: 'another' } }], nextCursor: null })
        expect((await one).item.nativeTurn).toEqual({ turnId: 'old-turn', itemId: 'old-source' })
        expect((await two).item.nativeTurn).toEqual({ turnId: 'other-turn', itemId: 'another' })
        await resolver.resolve(selections[0])
        expect(getCodexNativeItems).toHaveBeenCalledTimes(1)
    })

    it('uses persisted turn hints without scanning and stops a non-advancing legacy cursor', async () => {
        const getCodexNativeItems = vi.fn().mockResolvedValue({ data: [], nextCursor: 'same' })
        const getCodexNativeItem = vi.fn().mockResolvedValue({ entry: { turnId: 'old-turn', item: { id: 'old-source', type: 'agentMessage', text: 'original' } } })
        const resolver = new ResponseAnnotationResolver({ getCodexNativeItems, getCodexNativeItem } as unknown as ApiClient, native)
        await resolver.resolve({ ...selections[0], source: { ...selections[0].source, turnId: 'old-turn' } })
        expect(getCodexNativeItems).not.toHaveBeenCalled()
        await expect(resolver.resolve(selections[0])).rejects.toThrow('pagination did not advance')
        expect(getCodexNativeItems).toHaveBeenCalledTimes(2)
    })

    it('wraps a resumed legacy scan once to find a newer source evicted from the bounded index', async () => {
        const getCodexNativeItems = vi.fn(async (_thread, cursor?: string) => {
            const page = cursor === undefined ? 0 : Number(cursor)
            if (page === 84) return { data: [], nextCursor: null }
            if (page === 83) return { data: [{ turnId: 'old-turn', item: { id: 'old-source' } }], nextCursor: '84' }
            const data = Array.from({ length: 50 }, (_, index) => ({ turnId: 'filler-turn', item: { id: `filler:${page}:${index}` } }))
            if (page === 0) data[0] = { turnId: 'newer-turn', item: { id: 'newer-source' } }
            return { data, nextCursor: String(page + 1) }
        })
        const getCodexNativeItem = vi.fn(async (_thread, turnId, itemId) => ({ entry: { turnId, item: { id: itemId, type: 'agentMessage', text: 'original' } } }))
        const resolver = new ResponseAnnotationResolver({ getCodexNativeItems, getCodexNativeItem } as unknown as ApiClient, native)
        await resolver.resolve(selections[0])
        expect(getCodexNativeItems).toHaveBeenCalledTimes(84)
        const newer = await resolver.resolve({ ...selections[0], source: { ...selections[0].source, messageId: 'newer-source' } })
        expect(newer.item.nativeTurn).toEqual({ turnId: 'newer-turn', itemId: 'newer-source' })
        expect(getCodexNativeItems).toHaveBeenCalledTimes(86)
        expect(getCodexNativeItems.mock.calls.slice(-2).map(call => call[1])).toEqual(['84', undefined])
    })

    it('finds a runner prompt beyond the nearby context and retains real raw IDs for new sources', async () => {
        const answer = raw('answer', 60, 'agent', 'reply')
        const user = raw('user', 1, 'user', serializeResponseAnnotations('question', selections))
        const context = { message: answer, page: page([raw('tool', 50, 'agent', 'step'), answer], true), position: { at: 60, seq: 60 }, epoch: 1 }
        const getRunnerMessageContext = vi.fn().mockResolvedValue(context)
        const getMessages = vi.fn().mockResolvedValue(page([user]))
        const resolver = new ResponseAnnotationResolver({ getRunnerMessageContext, getMessages } as unknown as ApiClient, runner)
        resolver.observe([answer])
        expect(resolver.sourceForPart('agent-text:answer:0')).toEqual({ messageId: 'answer', partId: 'agent-text:answer:0' })
        expect(await resolver.readAnnotations('agent-text:answer:0')).toEqual(selections)
        expect(getMessages).toHaveBeenCalledTimes(1)
        const target = await resolver.resolve({ text: 'reply', source: { messageId: 'answer', partId: 'agent-text:answer:0', startOffset: 0, endOffset: 5 } })
        expect(target.item.historyPage).toEqual({ kind: 'runner', beforeAt: 60, beforeSeq: 61, epoch: 1 })
        await expect(resolver.resolve({ text: 'same text has no provenance' })).rejects.toThrow('no saved message location')
    })

    it('cancels one legacy lookup without cancelling another reference sharing its page', async () => {
        let release!: (value: unknown) => void
        const getCodexNativeItems = vi.fn().mockReturnValue(new Promise(resolve => { release = resolve }))
        const getCodexNativeItem = vi.fn().mockResolvedValue({ entry: { item: { id: 'old-source', type: 'agentMessage', text: 'original' } } })
        const resolver = new ResponseAnnotationResolver({ getCodexNativeItems, getCodexNativeItem } as unknown as ApiClient, native)
        const controller = new AbortController()
        const closed = resolver.resolve(selections[0], controller.signal)
        const open = resolver.resolve(selections[0])
        controller.abort()
        await expect(closed).rejects.toBeDefined()
        release({ data: [{ turnId: 'turn', item: { id: 'old-source' } }], nextCursor: null })
        expect((await open).item.targetMessageId).toBe('agent-text:native:old-source')
    })
})
