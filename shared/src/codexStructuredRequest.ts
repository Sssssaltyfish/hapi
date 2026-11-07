type RecordValue = Record<string, unknown>
type Event = { method: string; params?: unknown }
export type CodexStructuredRequestTransport = {
    request(method: string, params: RecordValue): Promise<unknown>
    /** Dedicated helper connection: subscribe before thread/start, remove after cleanup. */
    subscribe(listener: (event: Event) => void): () => void
    rejectRequest?(id: string | number, threadId: string): void
}
export type CodexStructuredRequestOptions = {
    settings?: RecordValue
    timeoutMs?: number
    cleanupTimeoutMs?: number
    signal?: AbortSignal
}
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
// Matches Codex's temporary_structured_request.rs isolation; do not inherit the source's tools.
const DISABLED_FEATURES = ['apps', 'code_mode', 'code_mode_only', 'context_management', 'current_time_reminder',
    'deferred_executor', 'enable_fanout', 'goals', 'hooks', 'image_generation', 'memories', 'multi_agent',
    'multi_agent_v2', 'plugins', 'request_permissions_tool', 'shell_snapshot', 'shell_tool',
    'standalone_web_search', 'token_budget', 'tool_suggest', 'unified_exec', 'view_image']

/** Run structured generation in an isolated daemon thread, never in the source conversation. */
export async function codexStructuredRequest<T>(
    transport: CodexStructuredRequestTransport, threadId: string, label: string, options: CodexStructuredRequestOptions,
    prepare: (request: CodexStructuredRequestTransport['request']) => Promise<{
        source: RecordValue; prompt: string; schema: RecordValue; context: T
    }>
): Promise<{ output: RecordValue; context: T }> {
    const name = label.toLowerCase()
    const timeoutMessage = `${label} generation timed out. Try again.`
    const invalidResponse = `The ${name} helper returned an invalid response.`
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
    const abort = () => { fail(`${label} was canceled.`); interruptHelper() }
    const remove = transport.subscribe(event => {
        const params = record(event.params)
        if (event.method === 'hapi/disconnected') { fail(`${label} could not connect to Codex. Reconnect and try again.`); return }
        if (!helperId) return
        if (event.method === 'hapi/request') {
            const request = record(event.params)
            if (record(request.params).threadId !== helperId) return
            if (typeof request.id === 'string' || typeof request.id === 'number') {
                try { transport.rejectRequest?.(request.id, helperId) } catch { /* Disconnect still fails the helper closed. */ }
            }
            fail(`The ${name} helper requested an unexpected interaction.`)
            return
        }
        if (params.threadId !== helperId) return
        if (event.method === 'turn/started') {
            turnId ??= string(record(params.turn).id)
            if (options.signal?.aborted) interruptHelper()
        }
        if (!['item/completed', 'turn/completed', 'error'].includes(event.method)) return
        if (events.length >= 128) { fail(`The ${name} helper returned too many events.`); return }
        // Only retain assistant text and completion metadata; unrelated tool output is never buffered.
        if (event.method === 'item/completed') {
            const item = record(params.item)
            if (item.type !== 'agentMessage') return
            if (typeof item.text !== 'string' || new TextEncoder().encode(item.text).length > 8 * 1024) {
                fail(invalidResponse); return
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
        return bounded(pending, deadline - Date.now(), timeoutMessage)
    }
    try {
        const { source, prompt, schema, context } = await prepare(request)
        const settings = options.settings ?? {}
        const model = string(source.model) ?? string(settings.model)
        const modelProvider = string(source.modelProvider) ?? string(settings.modelProvider)
        const cwd = string(source.cwd) ?? string(settings.cwd)
        if (!model || !modelProvider || !cwd) throw new Error(`Open the conversation to resolve its model, provider, and working directory before generating a ${name}.`)
        const config = record(record(await request('config/read', { cwd, includeLayers: false })).config)
        if (!Object.keys(config).length) throw new Error(`The ${name} helper configuration could not be confirmed.`)
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
        if (!helperId || helperId === threadId) { helperId = undefined; throw new Error(`The ${name} helper thread was not confirmed.`) }
        if (record(started.thread).ephemeral !== true) throw new Error(`The ${name} host did not confirm an ephemeral helper thread.`)
        if (customProfile ? record(started.activePermissionProfile).id !== customProfile : record(started.sandbox).type !== 'readOnly') {
            throw new Error(`The ${name} helper permissions could not be confirmed.`)
        }
        if (failure) throw failure
        const startedTurn = record(await request('turn/start', { threadId: helperId, input: [{ type: 'text', text: prompt, text_elements: [] }], outputSchema: schema }))
        const confirmedTurnId = string(record(startedTurn.turn).id)
        if (!confirmedTurnId || turnId && turnId !== confirmedTurnId) throw new Error(`The ${name} helper turn was not confirmed.`)
        turnId = confirmedTurnId
        let response: string | undefined
        while (!completed) {
            if (failure) throw failure
            while (events.length) {
                const event = events.shift()!
                const params = record(event.params)
                if (event.method === 'error' && (!params.turnId || params.turnId === turnId)) {
                    if (params.willRetry === true) continue
                    throw new Error(`${label} could not be generated. Try again later.`)
                }
                if (event.method === 'item/completed' && params.turnId === turnId) response = String(record(params.item).text)
                if (event.method === 'turn/completed' && record(params.turn).id === turnId) {
                    if (record(params.turn).status !== 'completed') throw new Error(`The ${name} helper did not complete successfully.`)
                    completed = true
                }
            }
            if (completed) break
            await bounded(new Promise<void>(resolve => { wake = resolve }), deadline - Date.now(), timeoutMessage)
            wake = undefined
        }
        let parsed: RecordValue
        try { parsed = record(JSON.parse(response ?? '')) } catch { throw new Error(invalidResponse) }
        if (failure) throw failure
        return { output: parsed, context }
    } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error))
        throw failure
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
