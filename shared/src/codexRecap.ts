import type { NativeCommandResult } from './codexThreadCommands'
import { codexRecapPrompt } from './codexRecapPrompt'
import {
    codexStructuredRequest,
    type CodexStructuredRequestOptions as CodexRecapOptions,
    type CodexStructuredRequestTransport as CodexRecapTransport,
} from './codexStructuredRequest'

export type { CodexRecapOptions, CodexRecapTransport }

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
const terminal = (turn: RecordValue) => ['completed', 'failed', 'interrupted'].includes(String(turn.status))
const OUTPUT_SCHEMA = {
    type: 'object', properties: {
        summary: { type: 'string', minLength: 1, maxLength: 700 },
        next_action: { type: ['string', 'null'], maxLength: 200 },
    }, required: ['summary', 'next_action'], additionalProperties: false,
}

async function turns(request: CodexRecapTransport['request'], threadId: string): Promise<RecordValue[]> {
    const page = record(await request('thread/turns/list', { threadId, sortDirection: 'desc', limit: 9, itemsView: 'full' }))
    if (!Array.isArray(page.data)) throw new Error('Conversation history was not confirmed')
    return page.data.map(record)
}

/** Codex TUI /recap workflow: isolated ephemeral structured turn, never source-thread input. */
export async function codexRecap(
    transport: CodexRecapTransport, threadId: string, options: CodexRecapOptions = {}
): Promise<Extract<NativeCommandResult, { command: 'recap' }>> {
    try {
        const { output: parsed, context: sourceTurnId } = await codexStructuredRequest(transport, threadId, 'Recap', options, async request => {
            const source = record(record(await request('thread/read', { threadId, includeTurns: false })).thread)
            const recent = await turns(request, threadId)
            const latest = recent[0] ?? {}
            const sourceTurnId = string(latest.id)
            if (record(source.status).type === 'active' || !sourceTurnId || !terminal(latest)) throw new Error('Recap requires an idle thread with a completed, failed, or interrupted turn')
            return { source, prompt: codexRecapPrompt([...recent].reverse()), schema: OUTPUT_SCHEMA, context: sourceTurnId }
        })
        const summary = string(parsed.summary)?.trim()
        const next = typeof parsed.next_action === 'string' ? parsed.next_action.trim() : parsed.next_action
        if (!summary || Array.from(summary).length > 700 || !(next === null || typeof next === 'string')
            || typeof next === 'string' && Array.from(next).length > 200
            || Object.keys(parsed).sort().join(',') !== 'next_action,summary') throw new Error('The recap helper returned an invalid response.')
        return { command: 'recap', sourceTurnId, text: next ? `${summary}\n\n${next}` : summary }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/429|quota|rate.?limit|credits|usage.?limit/i.test(message)) throw new Error('Recap is unavailable because of an account usage limit. Check your allowance before retrying.')
        if (/unknown variant|method not found|unknown method|unsupported method/i.test(message)) throw new Error('This Codex host does not support the temporary recap workflow. Upgrade Codex before retrying.')
        if (/network|connection|connect|socket|fetch failed/i.test(message)) throw new Error('Recap could not connect to Codex. Reconnect and try again.')
        if (/^(Recap |The recap |The conversation |Open the conversation |No conversation)/.test(message)) throw new Error(message)
        throw new Error('Recap could not be generated. Try again later.')
    }
}
