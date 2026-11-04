export type NativeQuestionReply = { questionItemId: string; question: string; answer: string }

const OPEN = '<send_user_message_question_reply>'
const CLOSE = '</send_user_message_question_reply>'

/** Presentation projection only; callers retain the original transport text. */
export function parseNativeQuestionReply(text: string): NativeQuestionReply[] | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) return null
    try {
        const parsed: unknown = JSON.parse(trimmed.slice(OPEN.length, -CLOSE.length))
        const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
        if (entries.length === 0) return null
        if (!entries.every((entry): entry is NativeQuestionReply => Boolean(
            entry && typeof entry === 'object'
            && typeof (entry as NativeQuestionReply).questionItemId === 'string'
            && typeof (entry as NativeQuestionReply).question === 'string'
            && typeof (entry as NativeQuestionReply).answer === 'string'
        ))) return null
        return entries
    } catch {
        return null
    }
}

export function nativeQuestionReplyDisplayText(text: string): string {
    return parseNativeQuestionReply(text)?.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n') ?? text
}
