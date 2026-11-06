import type { NativeCommandResult } from './codexThreadCommands'
import { codexRecapPrompt } from './codexRecapPrompt'

type RecordValue = Record<string, unknown>
type Event = { method: string; params?: unknown }
export type CodexRecapTransport = {
    request(method: string, params: RecordValue): Promise<unknown>
    /** Dedicated helper connection: subscribe before thread/start, remove after cleanup. */
    subscribe(listener: (event: Event) => void): () => void
    rejectRequest?(id: string | number, threadId: string): void
}
export type CodexRecapOptions = {
    settings?: RecordValue
    timeoutMs?: number
    cleanupTimeoutMs?: number
    signal?: AbortSignal
}
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
const terminal = (turn: RecordValue) => ['completed', 'failed', 'interrupted'].includes(String(turn.status))
const OUTPUT_SCHEMA = {
    type: 'object', properties: {
        summary: { type: 'string', minLength: 1, maxLength: 700 },
        next_action: { type: ['string', 'null'], maxLength: 200 },
    }, required: ['summary', 'next_action'], additionalProperties: false,
}
// Matches Codex's temporary_structured_request.rs isolation; do not inherit the source's tools.
const DISABLED_FEATURES = ['apps', 'code_mode', 'code_mode_only', 'context_management', 'current_time_reminder',
    'deferred_executor', 'enable_fanout', 'goals', 'hooks', 'image_generation', 'memories', 'multi_agent',
    'multi_agent_v2', 'plugins', 'request_permissions_tool', 'shell_snapshot', 'shell_tool',
    'standalone_web_search', 'token_budget', 'tool_suggest', 'unified_exec', 'view_image']

async function turns(request: CodexRecapTransport['request'], threadId: string): Promise<RecordValue[]> {
    const page = record(await request('thread/turns/list', { threadId, sortDirection: 'desc', limit: 9, itemsView: 'full' }))
    if (!Array.isArray(page.data)) throw new Error('Conversation history was not confirmed')
    return page.data.map(record)
}

/** Codex TUI /recap workflow: isolated ephemeral structured turn, never source-thread input. */
export async function codexRecap(
    transport: CodexRecapTransport, threadId: string, options: CodexRecapOptions = {}
): Promise<Extract<NativeCommandResult, { command: 'recap' }>> {
    const timeoutMs = options.timeoutMs ?? 30_000
    const cleanupMs = options.cleanupTimeoutMs ?? 5_000
    let helperId: string | undefined
    let turnId: string | undefined
    let completed = false
    let failure: Error | undefined
    let wake: (() => void) | undefined
    const events: Event[] = []
    const fail = (message: string) => { failure ??= new Error(message); wake?.() }
    let interruptedTurnId: string | undefined
    let interruption: Promise<unknown> | undefined
    const interruptHelper = () => {
        if (!helperId || !turnId || completed || interruptedTurnId === turnId) return
        interruptedTurnId = turnId
        interruption = transport.request('turn/interrupt', { threadId: helperId, turnId }).catch(() => {})
    }
    const abort = () => { fail('Recap was canceled.'); interruptHelper() }
    const remove = transport.subscribe(event => {
        const params = record(event.params)
        if (event.method === 'hapi/disconnected') { fail('Recap could not connect to Codex. Reconnect and try again.'); return }
        if (!helperId) return
        if (event.method === 'hapi/request') {
            const request = record(event.params)
            if (record(request.params).threadId !== helperId) return
            if (typeof request.id === 'string' || typeof request.id === 'number') {
                try { transport.rejectRequest?.(request.id, helperId) } catch { /* Disconnect still fails the helper closed. */ }
            }
            fail('The recap helper requested an unexpected interaction.')
            return
        }
        if (params.threadId !== helperId) return
        if (event.method === 'turn/started') {
            turnId ??= string(record(params.turn).id)
            if (options.signal?.aborted) interruptHelper()
        }
        if (!['item/completed', 'turn/completed', 'error'].includes(event.method)) return
        if (events.length >= 128) { fail('The recap helper returned too many events.'); return }
        // Only retain assistant text and completion metadata; unrelated tool output is never buffered.
        if (event.method === 'item/completed') {
            const item = record(params.item)
            if (item.type !== 'agentMessage') return
            if (typeof item.text !== 'string' || new TextEncoder().encode(item.text).length > 8 * 1024) {
                fail('The recap helper returned an invalid response.'); return
            }
        }
        events.push(event)
        wake?.()
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const deadline = Date.now() + timeoutMs
    const bounded = async <T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([promise, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), Math.max(1, milliseconds))
            })])
        } finally { clearTimeout(timer) }
    }
    const request = async (method: string, params: RecordValue): Promise<unknown> => {
        if (failure) throw failure
        const pending = transport.request(method, params)
        // A delayed thread/start response still needs detaching if the local deadline wins.
        if (method === 'thread/start') void pending.then(value => {
            if (!failure) return
            const lateId = string(record(record(value).thread).id)
            if (lateId && lateId !== threadId && lateId !== helperId) void transport.request('thread/unsubscribe', { threadId: lateId }).catch(() => {})
        }, () => {})
        return bounded(pending, deadline - Date.now(), 'Recap generation timed out. Try again.')
    }
    try {
        const source = record(record(await request('thread/read', { threadId, includeTurns: false })).thread)
        const recent = await turns(request, threadId)
        const latest = recent[0] ?? {}
        const sourceTurnId = string(latest.id)
        if (record(source.status).type === 'active' || !sourceTurnId || !terminal(latest)) throw new Error('Recap requires an idle thread with a completed, failed, or interrupted turn')
        const prompt = codexRecapPrompt([...recent].reverse())
        const settings = options.settings ?? {}
        const model = string(source.model) ?? string(settings.model)
        const modelProvider = string(source.modelProvider) ?? string(settings.modelProvider)
        const cwd = string(source.cwd) ?? string(settings.cwd)
        if (!model || !modelProvider || !cwd) throw new Error('Open the conversation to resolve its model, provider, and working directory before generating a recap.')
        const config = record(record(await request('config/read', { cwd, includeLayers: false })).config)
        if (!Object.keys(config).length) throw new Error('The recap helper configuration could not be confirmed.')
        const currentProfile = string(record(settings.activePermissionProfile).id)
        const customProfile = currentProfile && !currentProfile.startsWith(':') ? currentProfile : undefined
        const overrides: RecordValue = Object.fromEntries(DISABLED_FEATURES.map(feature => [`features.${feature}`, false]))
        Object.assign(overrides, {
            'cloud.skills.enabled': false, 'skills.include_instructions': false,
            'tools.experimental_request_user_input.enabled': false, 'tools.update_plan.enabled': false,
            web_search: 'disabled', mcp_servers: Object.fromEntries(Object.keys(record(config.mcp_servers)).map(name => [name, { enabled: false }])),
            ...(!customProfile ? { default_permissions: ':read-only' } : {}),
        })
        const started = record(await request('thread/start', {
            model, modelProvider, cwd, ephemeral: true, threadSource: 'system',
            ...(customProfile ? { permissions: customProfile } : { sandbox: 'read-only' }),
            runtimeWorkspaceRoots: [], environments: [], dynamicTools: [], selectedCapabilityRoots: [], config: overrides,
        }))
        helperId = string(record(started.thread).id)
        if (!helperId || helperId === threadId) { helperId = undefined; throw new Error('The recap helper thread was not confirmed.') }
        if (record(started.thread).ephemeral !== true) throw new Error('The recap host did not confirm an ephemeral helper thread.')
        if (customProfile ? record(started.activePermissionProfile).id !== customProfile : record(started.sandbox).type !== 'readOnly') {
            throw new Error('The recap helper permissions could not be confirmed.')
        }
        if (failure) throw failure
        const startedTurn = record(await request('turn/start', { threadId: helperId, input: [{ type: 'text', text: prompt, text_elements: [] }], outputSchema: OUTPUT_SCHEMA }))
        const confirmedTurnId = string(record(startedTurn.turn).id)
        if (!confirmedTurnId || turnId && turnId !== confirmedTurnId) throw new Error('The recap helper turn was not confirmed.')
        turnId = confirmedTurnId
        let response: string | undefined
        while (!completed) {
            if (failure) throw failure
            while (events.length) {
                const event = events.shift()!
                const params = record(event.params)
                if (event.method === 'error' && (!params.turnId || params.turnId === turnId)) {
                    if (params.willRetry === true) continue
                    throw new Error('Recap could not be generated. Try again later.')
                }
                if (event.method === 'item/completed' && params.turnId === turnId) response = String(record(params.item).text)
                if (event.method === 'turn/completed' && record(params.turn).id === turnId) {
                    if (record(params.turn).status !== 'completed') throw new Error('The recap helper did not complete successfully.')
                    completed = true
                }
            }
            if (completed) break
            await bounded(new Promise<void>(resolve => { wake = resolve }), deadline - Date.now(), 'Recap generation timed out. Try again.')
            wake = undefined
        }
        let parsed: RecordValue
        try { parsed = record(JSON.parse(response ?? '')) } catch { throw new Error('The recap helper returned an invalid response.') }
        const summary = string(parsed.summary)?.trim()
        const next = typeof parsed.next_action === 'string' ? parsed.next_action.trim() : parsed.next_action
        if (!summary || Array.from(summary).length > 700 || !(next === null || typeof next === 'string')
            || typeof next === 'string' && Array.from(next).length > 200
            || Object.keys(parsed).sort().join(',') !== 'next_action,summary') throw new Error('The recap helper returned an invalid response.')
        if (failure) throw failure
        return { command: 'recap', sourceTurnId, text: next ? `${summary}\n\n${next}` : summary }
    } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error))
        const message = failure.message
        if (/429|quota|rate.?limit|credits|usage.?limit/i.test(message)) throw new Error('Recap is unavailable because of an account usage limit. Check your allowance before retrying.')
        if (/unknown variant|method not found|unknown method|unsupported method/i.test(message)) throw new Error('This Codex host does not support the temporary recap workflow. Upgrade Codex before retrying.')
        if (/network|connection|connect|socket|fetch failed/i.test(message)) throw new Error('Recap could not connect to Codex. Reconnect and try again.')
        if (/^(Recap |The recap |The conversation |Open the conversation |No conversation)/.test(message)) throw new Error(message)
        throw new Error('Recap could not be generated. Try again later.')
    } finally {
        // No retries: an uncertain start must never create a second helper or turn.
        if (helperId) {
            interruptHelper()
            if (interruption) await bounded(interruption, cleanupMs, 'cleanup timeout').catch(() => {})
            await bounded(transport.request('thread/unsubscribe', { threadId: helperId }), cleanupMs, 'cleanup timeout').catch(() => {})
        }
        options.signal?.removeEventListener('abort', abort)
        remove()
    }
}
