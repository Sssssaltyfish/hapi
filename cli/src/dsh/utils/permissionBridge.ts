import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Embedded source also ships in compiled/npm binaries; no external asset lookup. */
export const DSH_PERMISSION_BRIDGE_SOURCE = String.raw`
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
const requireRuntime = createRequire(realpathSync(process.argv[1]))
const acpPath = requireRuntime.resolve('@deepseek-ai/dsh-acp')
const acp = await import(pathToFileURL(acpPath).href)
const { ndJsonStream } = await import(pathToFileURL(createRequire(acpPath).resolve('@agentclientprotocol/sdk')).href)
const { interpolate } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const { createUserMessage } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-llm')).href)
export const name = 'hapi-dsh-acp-permissions'
export const inject = acp.inject
export function apply(ctx) {
    // Capture the public service in the plugin's apply scope (Cordis context).
    const agents = ctx.agents
    const commands = ctx.get('commands')
    const sources = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-acp')
    if (sources.length !== 1 || !sources[0].disabled) throw new Error('HAPI requires one disabled original DSH ACP entry')
    const source = sources[0]
    const parsed = acp.Config['~standard'].validate(interpolate(source.context, source.options.config ?? {}))
    if (parsed.issues || !parsed.value) throw new Error('Original DSH ACP configuration is invalid')
    const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
    const writer = stream.writable.getWriter()
    const pending = new Map()
    const owned = new Map()
    const sessions = new Map()
    const steerMethod = '_hapi/dsh/steer'
    const commandMethod = '_hapi/dsh/command'
    const permissionId = 'hapi/permission-preset'
    const send = message => writer.write(message)
    const permissionOption = sessionId => {
        const permission = ctx.get('permissionPresets')
        const session = ctx.sessions.get(sessionId)
        if (!permission || !session) return undefined
        return { id: permissionId, name: 'Permission preset', category: 'permission', type: 'select',
            currentValue: permission.current(session), options: permission.catalog().options }
    }
    const optionsOf = (sessionId, original) => {
        const permission = permissionOption(sessionId)
        return [...original.filter(option => option.id !== permissionId), ...(permission ? [permission] : [])]
    }
    const scheduled = new Set()
    const notifyOptions = sessionId => {
        if (scheduled.has(sessionId)) return
        scheduled.add(sessionId)
        queueMicrotask(() => {
            scheduled.delete(sessionId)
            if (!owned.has(sessionId)) return
            void send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
                update: { sessionUpdate: 'config_option_update', configOptions: optionsOf(sessionId, owned.get(sessionId)) } }
            }).catch(error => ctx.logger.warn('HAPI permission catalog update failed: ' + String(error)))
        })
    }
    ctx.on('permission-presets/catalog-changed', () => { for (const id of owned.keys()) notifyOptions(id) })
    ctx.on('session/event', (session, event) => {
        if (owned.has(session.header.id) && ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)) notifyOptions(session.header.id)
    })
    const readable = stream.readable.pipeThrough(new TransformStream({
        async transform(message, controller) {
            if (message.method === commandMethod) {
                // A summary can take time. Keep the transport readable so
                // session/cancel can abort the public command invocation.
                void (async () => {
                    let state
                    let operation
                    try {
                        const { sessionId, operation: action, text } = message.params ?? {}
                        state = sessions.get(sessionId)
                        if (!commands || !state || agents.get(sessionId) !== state.agent || state.closing) throw new Error('DSH native commands are unavailable for this ACP session')
                        if (action === 'list') {
                            await send({ jsonrpc: '2.0', id: message.id, result: { commands: commands.list(state.agent) } })
                            return
                        }
                        if (action !== 'execute' || typeof text !== 'string' || !/^\/[a-z][a-z0-9-]*(?:\s|$)/.test(text)) throw new Error('Invalid DSH native command')
                        if (state.commandController || state.promptId !== undefined || state.agent.status !== 'idle') throw new Error('DSH native command requires an idle session')
                        operation = new AbortController()
                        state.commandController = operation
                        const execution = await commands.execute(state.agent, text, [], operation.signal)
                        if (!execution) throw new Error('DSH native command is not registered')
                        await ctx.sessions.flush(state.agent.session)
                        await send({ jsonrpc: '2.0', id: message.id, result: execution })
                    } catch (error) {
                        await send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } })
                    } finally {
                        if (operation && state?.commandController === operation) state.commandController = undefined
                    }
                })().catch(error => ctx.logger.warn('HAPI native command response failed: ' + String(error)))
                return
            }
            if (message.method === steerMethod) {
                try {
                    const { sessionId, requestId, text } = message.params ?? {}
                    if (typeof sessionId !== 'string' || typeof requestId !== 'string' || !requestId
                        || typeof text !== 'string' || !text.trim()) throw new Error('Invalid DSH steer request')
                    const state = sessions.get(sessionId)
                    if (!state || agents.get(sessionId) !== state.agent) throw new Error('DSH session is not owned by this ACP connection')
                    const previous = state.receipts.get(requestId)
                    if (previous) {
                        if (previous.text !== text) throw new Error('DSH steer request id was reused with different content')
                        await send({ jsonrpc: '2.0', id: message.id, result: previous.result })
                        return
                    }
                    if (state.closing || state.cancelled || state.promptId === undefined || state.agent.status !== 'running') {
                        throw new Error('No active DSH prompt accepts steering')
                    }
                    // Synchronous public native admission: no concurrent ACP prompt,
                    // cancellation, private loop fields, or replacement session.
                    state.agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
                    // Admission receipt, not a claim that the model consumed it.
                    const result = { accepted: true, requestId, delivery: 'native-steer' }
                    state.receipts.set(requestId, { text, result })
                    await send({ jsonrpc: '2.0', id: message.id, result })
                } catch (error) {
                    await send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } })
                }
                return
            }
            if (message.method === 'session/set_config_option' && message.params?.configId === permissionId) {
                try {
                    const { sessionId, value } = message.params
                    const original = owned.get(sessionId)
                    const option = original && permissionOption(sessionId)
                    if (!option || !option.options.some(entry => entry.value === value)) throw new Error('Permission preset is not advertised for this ACP session')
                    const session = ctx.sessions.get(sessionId)
                    ctx.get('permissionPresets').set(session, value)
                    await ctx.sessions.flush(session)
                    await send({ jsonrpc: '2.0', id: message.id, result: { configOptions: optionsOf(sessionId, original) } })
                } catch (error) {
                    await send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } })
                }
                return
            }
            const state = sessions.get(message.params?.sessionId)
            if (state) {
                if (message.method === 'session/prompt' && state.promptId === undefined) {
                    state.promptId = message.id
                    state.cancelled = false
                }
                if (message.method === 'session/cancel') state.cancelled = true
                if (message.method === 'session/close') state.closing = true
                if (message.method === 'session/cancel' || message.method === 'session/close') state.commandController?.abort()
            }
            if (message.id !== undefined && message.method) pending.set(message.id, { method: message.method, params: message.params })
            controller.enqueue(message)
        },
    }))
    const writable = new WritableStream({
        async write(message) {
            if (message.method === 'session/update' && message.params?.update?.sessionUpdate === 'config_option_update') {
                const id = message.params.sessionId
                const original = message.params.update.configOptions
                if (owned.has(id) && Array.isArray(original)) {
                    owned.set(id, original)
                    message = { ...message, params: { ...message.params, update: { ...message.params.update, configOptions: optionsOf(id, original) } } }
                }
            }
            if (message.id !== undefined && !message.method) {
                const request = pending.get(message.id)
                pending.delete(message.id)
                const active = sessions.get(request?.params?.sessionId)
                if (request?.method === 'session/prompt' && active?.promptId === message.id) active.promptId = undefined
                if (request?.method === 'session/close' && message.error && active) active.closing = false
                if (request && message.result) {
                    const id = request.method === 'session/new' ? message.result.sessionId : request.params?.sessionId
                    if (request.method === 'initialize') {
                        const capabilities = message.result.agentCapabilities ?? {}
                        message = { ...message, result: { ...message.result, agentCapabilities: { ...capabilities,
                            _meta: { ...capabilities._meta, 'hapi.dshSteering': { version: 1, method: steerMethod },
                                ...(commands ? { 'hapi.dshCommands': { version: 1, method: commandMethod } } : {}) } } } }
                    }
                    if (id && ['session/new', 'session/load', 'session/resume'].includes(request.method)) {
                        const agent = agents.get(id)
                        if (agent) sessions.set(id, { agent, receipts: new Map(), promptId: undefined, closing: false, cancelled: false })
                    }
                    if (id && Array.isArray(message.result.configOptions)) {
                        owned.set(id, message.result.configOptions)
                        message = { ...message, result: { ...message.result, configOptions: optionsOf(id, message.result.configOptions) } }
                    }
                    if (request.method === 'session/close') { owned.delete(id); sessions.delete(id) }
                }
            }
            await send(message)
        },
    })
    // Public transport override; all original lifecycle, prompt and approval handling stays upstream.
    acp.apply(ctx, { ...parsed.value, stream: { readable, writable } })
}
`

export async function prepareDshPermissionBridge(env: NodeJS.ProcessEnv = process.env): Promise<{
    args: string[]
    cleanup: () => Promise<void>
}> {
    // Custom ACP servers keep their own contract and advertise their own options.
    if (env.HAPI_DSH_ACP_COMMAND?.trim() || env.HAPI_DSH_ACP_ARGS_JSON?.trim()) {
        return { args: [], cleanup: async () => {} }
    }
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-acp-'))
    const cleanup = async () => { await rm(directory, { recursive: true, force: true }) }
    try {
        const plugin = join(directory, 'permissions.mjs')
        const patch = join(directory, 'permissions.patch.yml')
        await writeFile(plugin, DSH_PERMISSION_BRIDGE_SOURCE, { mode: 0o600 })
        await writeFile(patch, '- id: acp\n  disabled: true\n- insert:\n    - id: hapi-acp-permissions\n      name: '
            + JSON.stringify(pathToFileURL(plugin).href) + '\n      inject: [acpAppStartup]\n', { mode: 0o600 })
        return { args: ['--patch', patch], cleanup }
    } catch (error) {
        await cleanup()
        throw error
    }
}
