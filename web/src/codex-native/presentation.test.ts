import { describe, expect, it } from 'vitest'
import { nativeQuestionReplies } from './presentation'

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
