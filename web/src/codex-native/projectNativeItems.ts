import type { DecryptedMessage, Session } from '@/types/api'
import { nativeQuestionReplies, nativeText, record } from './presentation'
import type { NativeItemEntry, NativeRecord, NativeRequest } from './types'
import { nativeCollaborationTool, nativeSubagentEvent } from './nativeCollaboration'

/** Presentation only. No native record is imported into HAPI storage. */
export function projectNativeItems(
    entries: NativeItemEntry[],
    requests: NativeRequest[],
    canAnswerAsync = true,
    observedReplies: ReadonlyMap<string, string> = new Map()
) {
    const messages: DecryptedMessage[] = []
    const pending: NonNullable<NonNullable<Session['agentState']>['requests']> = {}
    const replies = new Map([...observedReplies, ...nativeQuestionReplies(entries)])
    const subagentStatuses = new Map<string, string>()
    const subagentInputs = new Map<string, NativeRecord>()
    const add = (id: string, timestamp: number, body: NativeRecord, user = false) => {
        messages.push({
            id,
            localId: id,
            seq: null,
            createdAt: timestamp,
            invokedAt: timestamp,
            content: user
                ? {
                      role: 'user',
                      content: { type: 'text', text: body.text },
                      meta: { sentFrom: 'cli' },
                  }
                : {
                      role: 'agent',
                      content: { type: 'codex', data: { ...body, id } },
                      meta: { sentFrom: 'cli' },
                  },
        })
    }
    const tool = (
        id: string,
        at: number,
        name: string,
        input: unknown,
        output: unknown,
        complete: boolean,
        turnId?: string,
        completedAt?: number | null,
        isError = false
    ) => {
        add(`${id}:call`, at, { type: 'tool-call', name, callId: id, input, turn_id: turnId })
        if (complete)
            add(`${id}:result`, completedAt ?? at, {
                type: 'tool-call-result',
                callId: id,
                output,
                is_error: isError,
                turn_id: turnId,
            })
    }
    for (const entry of entries) {
        const { item } = entry
        const id = `native:${item.id}`
        const at = entry.startedAtMs ?? entry.completedAtMs ?? entry.observedAtMs ?? 0
        const completed =
            entry.completedAtMs != null || item.status === 'completed' || item.status === 'failed'
        const collaboration = item.type === 'collabAgentToolCall' ? nativeCollaborationTool(item) : null
        if (item.type === 'userMessage' || item.type === 'steeringUserMessage') {
            if (item.type === 'steeringUserMessage' && item.status !== 'accepted') continue
            const content = item.content ?? item.input
            const text = Array.isArray(content)
                ? content
                      .map((value) => {
                          const part = record(value)
                          if (typeof part.text === 'string') return part.text
                          if (part.type === 'image') return '[Image]'
                          if (part.type === 'localImage')
                              return `[Image: ${String(part.path ?? '')}]`
                          if (part.type === 'mention') return ''
                          return part.type
                              ? `[${String(part.type)}: ${String(part.path ?? part.name ?? '')}]`
                              : ''
                      })
                      .filter(Boolean)
                      .join('\n')
                : nativeText(content)
            if (text) add(id, at, { text }, true)
        } else if (item.type === 'agentMessage') {
            const text = nativeText(item.text)
            if (text) add(id, at, { type: 'message', message: text, turn_id: entry.turnId })
            if (Array.isArray(item.questions)) {
                const questions = item.questions.map((value, index) => {
                    const question = record(value)
                    return {
                        id: JSON.stringify(['request_user_input_async', item.id, index]),
                        header: String(question.title ?? ''),
                        question: String(question.title ?? ''),
                        options: Array.isArray(question.options)
                            ? question.options.map((label) => ({
                                  label: String(label),
                                  description: '',
                              }))
                            : [],
                    }
                })
                const answers = Object.fromEntries(
                    questions
                        .filter((question) => replies.has(question.id))
                        .map((question) => [question.id, { answers: [replies.get(question.id)!] }])
                )
                const unanswered = questions.some((question) => !replies.has(question.id))
                const requestId = `native-async:${item.id}`
                const input = {
                    questions: unanswered
                        ? questions.filter((question) => !replies.has(question.id))
                        : questions,
                }
                tool(
                    requestId,
                    at,
                    'request_user_input',
                    input,
                    { answers },
                    !unanswered,
                    entry.turnId,
                    entry.completedAtMs
                )
                if (unanswered && canAnswerAsync)
                    pending[requestId] = {
                        tool: 'request_user_input',
                        toolCallId: requestId,
                        arguments: input,
                        createdAt: at,
                    }
            }
        } else if (item.type === 'reasoning') {
            const text = nativeText(item.summary) || nativeText(item.content)
            if (text) add(id, at, { type: 'reasoning', message: text, turn_id: entry.turnId })
        } else if (item.type === 'commandExecution') {
            tool(
                id,
                at,
                'CodexBash',
                { command: item.command, cwd: item.cwd, call_id: item.id },
                {
                    stdout: item.aggregatedOutput ?? item.output ?? '',
                    exit_code: item.exitCode,
                    duration_ms: item.durationMs,
                },
                completed,
                entry.turnId,
                entry.completedAtMs
            )
        } else if (item.type === 'fileChange') {
            tool(
                id,
                at,
                'CodexPatch',
                { changes: item.changes },
                { success: item.status === 'completed', changes: item.changes },
                completed,
                entry.turnId,
                entry.completedAtMs
            )
        } else if (item.type === 'mcpToolCall') {
            tool(
                id,
                at,
                `mcp__${String(item.server)}__${String(item.tool)}`,
                item.arguments,
                item.result ?? item.error,
                completed,
                entry.turnId,
                entry.completedAtMs
            )
        } else if (item.type === 'subAgentActivity') {
            const agentId = String(item.agentThreadId ?? '')
            const event = nativeSubagentEvent(item, subagentStatuses.get(agentId), subagentInputs.get(agentId)?.startTimeKnown === true)
            if (event) {
                subagentStatuses.set(agentId, String(event.status))
                event.input = { ...subagentInputs.get(agentId), ...record(event.input) }
                subagentInputs.set(agentId, record(event.input))
                add(id, at, { ...event, turn_id: entry.turnId })
            }
        } else if (collaboration) {
            tool(id, at, collaboration.name, collaboration.input, collaboration.output,
                completed, entry.turnId, entry.completedAtMs, item.status === 'failed' || Boolean(item.error))
        } else if (item.type === 'plan') {
            const text = nativeText(item.text)
            if (text) add(id, at, { type: 'message', message: text, turn_id: entry.turnId })
        } else {
            tool(
                id,
                at,
                String(item.tool ?? item.type),
                item.arguments ?? item,
                item.result ?? item.output ?? item,
                completed,
                entry.turnId,
                entry.completedAtMs
            )
        }
    }
    for (const request of requests) {
        const id = String(request.id)
        const source = entries.find((entry) => entry.item.id === request.params.itemId)
        const at =
            source?.startedAtMs ??
            source?.completedAtMs ??
            (typeof request.params.createdAt === 'number'
                ? request.params.createdAt
                : request.receivedAt)
        const name =
            request.method === 'item/tool/requestUserInput'
                ? 'request_user_input'
                : request.method === 'item/commandExecution/requestApproval'
                  ? 'CodexBash'
                  : request.method === 'item/fileChange/requestApproval'
                    ? 'CodexPatch'
                    : 'native_request_unsupported'
        const toolId = source ? `native:${source.item.id}` : id
        if (!source && at !== undefined)
            tool(
                toolId,
                at,
                name,
                { ...request.params, nativeRequestReceivedAt: request.receivedAt },
                name === 'native_request_unsupported'
                    ? 'This request requires Codex Desktop'
                    : null,
                name === 'native_request_unsupported'
            )
        if (name !== 'native_request_unsupported')
            pending[id] = {
                tool: name,
                toolCallId: toolId,
                arguments: request.params,
                createdAt: at,
            }
    }
    return { messages, requests: pending }
}
