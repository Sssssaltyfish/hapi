import type { DecryptedMessage, Session } from '@/types/api'
import { nativeQuestionReplies, nativeText, record } from './presentation'
import type { NativeItemEntry, NativeRecord, NativeRequest } from './types'
import { nativeCollaborationTool, nativeSubagentEvent } from './nativeCollaboration'
import { nativeReasoningMessageId, nativeReasoningParts } from './nativeReasoning'
import { getInlineMediaMimeType } from '@/lib/generatedInlineMedia'
import { projectNativeUserText } from './skillReferences'

function nativePatchChanges(value: unknown): NativeRecord {
    if (!Array.isArray(value)) return record(value)
    return Object.fromEntries(value.flatMap((value) => {
        const change = record(value)
        return typeof change.path === 'string' && change.path ? [[change.path, change]] : []
    }))
}

function latestActiveReasoning(entries: NativeItemEntry[], activeTurnId?: string) {
    if (!activeTurnId) return
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
        const { item, turnId } = entries[entryIndex]
        if (turnId !== activeTurnId) continue
        if (item.type === 'userMessage' || (item.type === 'steeringUserMessage' && item.status === 'accepted') ||
            (item.type === 'agentMessage' && (item.phase === 'commentary' || item.phase === 'final_answer' || nativeText(item.text).trim())) ||
            (item.type === 'plan' && nativeText(item.text).trim())) return
        if (item.type !== 'reasoning') continue
        const parts = nativeReasoningParts(item.summary)
        for (let index = parts.length - 1; index >= 0; index--) {
            if (parts[index]?.trim()) return { entry: entries[entryIndex], id: nativeReasoningMessageId(item.id, index) }
        }
    }
    return undefined
}

type ProjectionCache = WeakMap<NativeItemEntry, { messages: DecryptedMessage[]; activeReasoningId?: string }>

/** Reuse the projection of immutable entries retained by this native chat. */
export function createNativeItemProjector() {
    const cache: ProjectionCache = new WeakMap()
    return (
        entries: NativeItemEntry[], requests: NativeRequest[], canAnswerAsync?: boolean,
        observedReplies?: ReadonlyMap<string, string>, activeTurnId?: string,
    ) => projectNativeItems(entries, requests, canAnswerAsync, observedReplies, activeTurnId, cache)
}

/** Presentation only. No native record is imported into HAPI storage. */
export function projectNativeItems(
    entries: NativeItemEntry[],
    requests: NativeRequest[],
    canAnswerAsync = true,
    observedReplies: ReadonlyMap<string, string> = new Map(),
    activeTurnId?: string,
    cache?: ProjectionCache,
) {
    const messages: DecryptedMessage[] = []
    const pending: NonNullable<NonNullable<Session['agentState']>['requests']> = {}
    let replies: Map<string, string> | undefined
    const activeReasoning = latestActiveReasoning(entries, activeTurnId)
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
                      meta: {
                          sentFrom: 'cli',
                          nativeCodexRecord: true,
                          ...(typeof body.turn_id === 'string' ? {
                              codexTurnId: body.turn_id,
                          } : {}),
                          ...(body.nativeMessagePhase === 'commentary' || body.nativeMessagePhase === 'final_answer'
                              ? { nativeCodexMessagePhase: body.nativeMessagePhase } : {}),
                          ...(typeof body.nativeResponseItemId === 'string'
                              ? { nativeCodexResponseItemId: body.nativeResponseItemId } : {}),
                          ...(typeof body.nativeReasoningSummaryIndex === 'number'
                              ? { nativeReasoningSummaryIndex: body.nativeReasoningSummaryIndex, nativeReasoningActive: body.nativeReasoningActive === true } : {}),
                      },
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
        const activeReasoningId = activeReasoning?.entry === entry ? activeReasoning.id : undefined
        // Question tools depend on replies and runtime state outside this entry.
        const entryCache = item.type === 'agentMessage' && Array.isArray(item.questions) ? undefined : cache
        const cached = entryCache?.get(entry)
        if (cached && cached.activeReasoningId === activeReasoningId) {
            for (const message of cached.messages) messages.push(message)
            continue
        }
        const messageStart = messages.length
        const id = `native:${item.id}`
        const at = entry.startedAtMs ?? entry.completedAtMs ?? entry.observedAtMs ?? 0
        const completed =
            entry.completedAtMs != null || item.status === 'completed' || item.status === 'failed'
        const savedPath = item.type === 'imageGeneration' && completed && item.status !== 'failed'
            && typeof item.savedPath === 'string' && item.savedPath.trim() ? item.savedPath : undefined
        const collaboration = item.type === 'collabAgentToolCall' ? nativeCollaborationTool(item) : null
        if (item.type === 'userMessage' || item.type === 'steeringUserMessage') {
            if (item.type === 'steeringUserMessage' && item.status !== 'accepted') continue
            const text = projectNativeUserText(item.content ?? item.input)
            if (text) add(id, at, { text }, true)
        } else if (item.type === 'agentMessage') {
            const text = nativeText(item.text)
            if (text) add(id, at, {
                type: 'message', message: text, turn_id: entry.turnId, nativeResponseItemId: item.id,
                nativeMessagePhase: item.phase,
            })
            if (Array.isArray(item.questions)) {
                const currentReplies = replies ??= new Map([...observedReplies, ...nativeQuestionReplies(entries)])
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
                        .filter((question) => currentReplies.has(question.id))
                        .map((question) => [question.id, { answers: [currentReplies.get(question.id)!] }])
                )
                const unanswered = questions.some((question) => !currentReplies.has(question.id))
                const requestId = `native-async:${item.id}`
                const input = {
                    questions: unanswered
                        ? questions.filter((question) => !currentReplies.has(question.id))
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
        } else if (savedPath) {
            const fileName = savedPath.split(/[\\/]/).pop() || 'generated-image'
            add(id, at, {
                type: 'generated-image', imageId: item.id, nativeFilePath: savedPath, fileName,
                mimeType: getInlineMediaMimeType(fileName) ?? 'image/png',
                turn_id: entry.turnId,
            })
        } else if (item.type === 'reasoning') {
            nativeReasoningParts(item.summary).forEach((text, index) => {
                if (!text.trim()) return
                const summaryId = nativeReasoningMessageId(item.id, index)
                add(summaryId, at, {
                    type: 'reasoning', message: text, turn_id: entry.turnId, nativeResponseItemId: item.id,
                    nativeReasoningSummaryIndex: index, nativeReasoningActive: summaryId === activeReasoningId,
                })
            })
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
            const failed = item.status === 'failed' || item.status === 'declined'
            tool(
                id,
                at,
                'CodexPatch',
                { changes: nativePatchChanges(item.changes) },
                { status: item.status, stdout: item.stdout, stderr: item.stderr, output: item.output, error: item.error },
                completed || failed,
                entry.turnId,
                entry.completedAtMs,
                failed
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
            const event = nativeSubagentEvent(item)
            if (event) {
                add(id, at, { ...event, turn_id: entry.turnId })
            }
        } else if (collaboration) {
            tool(id, at, collaboration.name, collaboration.input, collaboration.output,
                completed || item.status === 'interrupted', entry.turnId, entry.completedAtMs,
                item.status === 'failed' || Boolean(item.error))
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
        entryCache?.set(entry, { messages: messages.slice(messageStart), activeReasoningId })
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
