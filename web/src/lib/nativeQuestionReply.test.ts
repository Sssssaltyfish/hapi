import { expect, it } from 'vitest'
import { nativeQuestionReplyDisplayText, parseNativeQuestionReply } from './nativeQuestionReply'

it('projects array and single-object replies as readable question/answer text', () => {
    const replies = [
        { questionItemId: 'opaque 1', question: 'Choose a color?', answer: 'Blue\nCustom detail' },
        { questionItemId: 'opaque 2', question: 'Next?', answer: 'Continue' },
    ]
    const wrap = (value: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`
    expect(parseNativeQuestionReply(wrap(replies))).toEqual(replies)
    expect(parseNativeQuestionReply(wrap(replies[0]))).toEqual([replies[0]])
    expect(nativeQuestionReplyDisplayText(wrap(replies))).toBe('Choose a color?\nBlue\nCustom detail\n\nNext?\nContinue')
})

it('preserves malformed protocols and quoted wrapper examples as ordinary text', () => {
    for (const text of [
        '<send_user_message_question_reply>not JSON</send_user_message_question_reply>',
        '<send_user_message_question_reply>[{"question":"incomplete"}]</send_user_message_question_reply>',
        'Example: <send_user_message_question_reply>[]</send_user_message_question_reply>',
    ]) {
        expect(parseNativeQuestionReply(text)).toBeNull()
        expect(nativeQuestionReplyDisplayText(text)).toBe(text)
    }
})
