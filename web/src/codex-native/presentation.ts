import type { NativeItemEntry, NativeRecord, NativeThread } from './types'

export function record(value: unknown): NativeRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as NativeRecord)
        : {}
}

export function nativeTitle(thread: NativeThread): string {
    return thread.name?.trim() || thread.title?.trim() || thread.preview?.trim() || thread.id
}

export function nativeState(value: unknown): string {
    if (typeof value === 'string') return value
    const state = record(value)
    return typeof state.type === 'string' ? state.type : 'unknown'
}

export function nativeText(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value))
        return value
            .map((part) => {
                const item = record(part)
                return typeof item.text === 'string' ? item.text : ''
            })
            .filter(Boolean)
            .join('\n')
    return ''
}

export function mergeNativeItems(
    current: NativeItemEntry[],
    incoming: NativeItemEntry[],
    direction: 'older' | 'latest',
    limit = 300
): NativeItemEntry[] {
    const combined = direction === 'older' ? [...incoming, ...current] : [...current, ...incoming]
    const seen = new Map<string, NativeItemEntry>()
    for (const entry of combined) {
        const previous = seen.get(entry.item.id)
        const fields = Object.fromEntries(
            Object.entries(entry).filter(([, value]) => value !== undefined)
        )
        seen.set(entry.item.id, { ...previous, ...fields, item: entry.item } as NativeItemEntry)
    }
    const entries = [...seen.values()]
    return direction === 'older' ? entries.slice(0, limit) : entries.slice(-limit)
}

export function quoteNativeSelection(draft: string, selection: string): string {
    return `${draft.trimEnd()}${draft.trim() ? '\n\n' : ''}${selection
        .trim()
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`
}

export function nativeToolSummary(item: NativeRecord): string {
    if (typeof item.tool === 'string') return item.tool
    if (typeof item.command === 'string') return item.command
    if (typeof item.name === 'string') return item.name
    return String(item.type ?? 'Tool')
}

export function nativeQuestionReplies(entries: NativeItemEntry[]): Map<string, string> {
    const answers = new Map<string, string>()
    const start = '<send_user_message_question_reply>'
    const end = '</send_user_message_question_reply>'
    for (const { item } of entries) {
        if (
            item.type !== 'userMessage' &&
            !(item.type === 'steeringUserMessage' && item.status === 'accepted')
        )
            continue
        const text = nativeText(item.content ?? item.input).trim()
        if (!text.startsWith(start) || !text.endsWith(end)) continue
        try {
            const parsed: unknown = JSON.parse(text.slice(start.length, -end.length))
            for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
                const reply = record(value)
                if (
                    typeof reply.questionItemId === 'string' &&
                    typeof reply.question === 'string' &&
                    typeof reply.answer === 'string'
                )
                    answers.set(reply.questionItemId, reply.answer)
            }
        } catch {
            /* Ordinary user text that resembles a wrapper remains ordinary text. */
        }
    }
    return answers
}

export function nativeAsyncReplyTurn(activeTurn: unknown): string | undefined {
    if (activeTurn === undefined) throw new Error('Native turn state is still loading')
    const turn = record(activeTurn)
    return turn.status === 'inProgress' && typeof turn.id === 'string' ? turn.id : undefined
}
