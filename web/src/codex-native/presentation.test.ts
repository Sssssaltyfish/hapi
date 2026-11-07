import { describe, expect, it } from 'vitest'
import { mergeNativeItems, nativeQuestionReplies } from './presentation'

it('retains unchanged native entries while applying duplicate metadata and window bounds', () => {
    const first = { item: { id: 'first', type: 'agentMessage' } }
    const streaming = { turnId: 'turn', startedAtMs: 1, item: { id: 'live', type: 'reasoning', summary: ['A'] } }
    const update = { startedAtMs: undefined, completedAtMs: 2, item: { ...streaming.item, summary: ['AB'] } }
    const last = { item: { id: 'last', type: 'agentMessage' } }
    const result = mergeNativeItems([first, streaming], [update, last], 'latest')
    expect(result[0]).toBe(first)
    expect(result[1]).toEqual({ ...streaming, completedAtMs: 2, item: update.item })
    expect(result[2]).toBe(last)
    expect(mergeNativeItems([first, streaming], [update, last], 'latest', 1)[0]).toBe(last)
    expect(mergeNativeItems([streaming, last], [first, update], 'older', 2)).toEqual([
        first, { ...streaming, completedAtMs: 2 },
    ])
})

describe('native async question replies', () => {
    it('uses accepted native replies and ignores pending steering and ordinary quoted wrappers', () => {
        const reply = (id: string) => `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: id, question: 'Choose', answer: 'Yes' }])}\n</send_user_message_question_reply>`
        const replies = nativeQuestionReplies([
            { item: { id: 'a', type: 'steeringUserMessage', status: 'pending', input: [{ type: 'text', text: reply('pending') }] } },
            { item: { id: 'b', type: 'steeringUserMessage', status: 'accepted', input: [{ type: 'text', text: reply('accepted') }] } },
            { item: { id: 'c', type: 'userMessage', content: [{ type: 'text', text: reply('normal') }] } },
            { item: { id: 'd', type: 'userMessage', content: [{ type: 'text', text: `Quote: ${reply('quoted')}` }] } },
        ])
        expect([...replies]).toEqual([['accepted', 'Yes'], ['normal', 'Yes']])
    })
})
