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
export const name = 'hapi-dsh-acp-permissions'
export const inject = acp.inject
export function apply(ctx) {
    const sources = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-acp')
    if (sources.length !== 1 || !sources[0].disabled) throw new Error('HAPI requires one disabled original DSH ACP entry')
    const source = sources[0]
    const parsed = acp.Config['~standard'].validate(interpolate(source.context, source.options.config ?? {}))
    if (parsed.issues || !parsed.value) throw new Error('Original DSH ACP configuration is invalid')
    const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
    const writer = stream.writable.getWriter()
    const pending = new Map()
    const owned = new Map()
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
                if (request && message.result) {
                    const id = request.method === 'session/new' ? message.result.sessionId : request.params?.sessionId
                    if (id && Array.isArray(message.result.configOptions)) {
                        owned.set(id, message.result.configOptions)
                        message = { ...message, result: { ...message.result, configOptions: optionsOf(id, message.result.configOptions) } }
                    }
                    if (request.method === 'session/close') owned.delete(id)
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
