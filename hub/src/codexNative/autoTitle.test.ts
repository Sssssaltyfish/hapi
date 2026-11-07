import { describe, expect, test } from 'bun:test'
import { serializeResponseAnnotations } from '@hapi/protocol/codexInputContext'
import { NativeService } from './service'
import { record, type NativeConnection, type NativeEvent, type NativeRecord } from './transport'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

function fixture() {
    type Client = { emit: (event: NativeEvent) => void }
    const calls: Array<{ method: string; params: NativeRecord }> = []
    const helperStarted = deferred<Client>()
    const helperClosed = deferred<void>()
    const autoWriteStarted = deferred<void>()
    const state = { name: null as string | null, autoWriteBarrier: undefined as Promise<void> | undefined }
    const sourceId = 'source'
    const prompt = '修复任务列表中重复显示的记录'
    const input = serializeResponseAnnotations(prompt, [{ text: 'Previous assistant output' }])
    let source: Client
    let helper: Client | undefined
    const service = new NativeService({ endpoint: 'ws://unused', namespace: 'owner' }, () => {
        const listeners = new Set<(event: NativeEvent) => void>()
        const client = {
            listeners, requests: new Map(),
            async connect() {},
            emit(event: NativeEvent) { for (const listener of listeners) listener(event) },
            close() {
                client.emit({ method: 'hapi/disconnected' })
                if (client === helper) helperClosed.resolve()
                listeners.clear()
            },
            async request(method: string, params: NativeRecord) {
                calls.push({ method, params })
                if (method === 'thread/start') {
                    if (params.ephemeral === true) {
                        helper = client
                        return { thread: { id: 'helper', ephemeral: true }, sandbox: { type: 'readOnly' } }
                    }
                    source = client
                    return { model: 'chosen-model', thread: { id: sourceId, cwd: '/repo', modelProvider: 'chosen-provider', name: null } }
                }
                if (method === 'thread/queue/add') {
                    const event = {
                        threadId: sourceId, turnId: 'first-turn',
                        item: { id: 'user-item', type: 'userMessage', content: params.input },
                    }
                    source.emit({ method: 'item/started', params: event })
                    source.emit({ method: 'item/completed', params: event })
                    return { queuedSubmission: { id: 'queued' } }
                }
                if (method === 'config/read') return { config: { mcp_servers: { existing: { enabled: true } } } }
                if (method === 'turn/start') {
                    helperStarted.resolve(client)
                    return { turn: { id: 'helper-turn' } }
                }
                if (method === 'thread/read') return { thread: { id: sourceId, name: state.name } }
                if (method === 'thread/name/set') {
                    if (client === helper) {
                        autoWriteStarted.resolve()
                        await state.autoWriteBarrier
                    }
                    state.name = String(params.name)
                }
                return {}
            },
        }
        return client as unknown as NativeConnection
    })
    const complete = (client: Client) => {
        client.emit({ method: 'item/completed', params: {
            threadId: 'helper', turnId: 'helper-turn',
            item: { type: 'agentMessage', text: JSON.stringify({ title: '修复任务列表的重复记录' }) },
        } })
        client.emit({ method: 'turn/completed', params: { threadId: 'helper', turn: { id: 'helper-turn', status: 'completed' } } })
    }
    return { service, calls, state, prompt, input, sourceId, helperStarted, helperClosed, autoWriteStarted, complete }
}

describe('new native conversation titles', () => {
    test('titles the first accepted request once using an isolated daemon turn', async () => {
        const { service, calls, state, prompt, input, helperStarted, helperClosed, complete } = fixture()
        try {
            const result = await service.startThread({ cwd: '/repo', threadSource: 'user' }, { text: input, clientId: 'first' })
            expect(record(result.queued).queuedSubmission).toEqual({ id: 'queued' })
            const helper = await helperStarted.promise
            expect(state.name).toBeNull()
            complete(helper)
            await helperClosed.promise

            expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
            const turn = calls.find(call => call.method === 'turn/start')!
            expect(turn.params.threadId).toBe('helper')
            expect(JSON.stringify(turn.params.input)).toContain(prompt)
            expect(JSON.stringify(turn.params.input)).not.toContain('Previous assistant output')
            expect(calls.find(call => call.method === 'thread/start' && call.params.ephemeral)?.params).toMatchObject({
                ephemeral: true, model: 'chosen-model', modelProvider: 'chosen-provider', sandbox: 'read-only',
                config: { 'features.shell_tool': false, mcp_servers: { existing: { enabled: false } } },
            })
            expect(calls.slice(-3)).toEqual([
                { method: 'thread/unsubscribe', params: { threadId: 'helper' } },
                { method: 'thread/read', params: { threadId: 'source', includeTurns: false } },
                { method: 'thread/name/set', params: { threadId: 'source', name: '修复任务列表的重复记录' } },
            ])
        } finally { service.dispose() }
    })

    test('preserves a Desktop title written while generation was running', async () => {
        const { service, calls, state, input, helperStarted, helperClosed, complete } = fixture()
        try {
            await service.startThread({ cwd: '/repo' }, { text: input, clientId: 'first' })
            const helper = await helperStarted.promise
            state.name = 'Name set in Desktop'
            complete(helper)
            await helperClosed.promise
            expect(calls.some(call => call.method === 'thread/name/set')).toBe(false)
            expect(state.name).toBe('Name set in Desktop')
        } finally { service.dispose() }
    })

    test('an explicit HAPI rename cancels pending generation', async () => {
        const { service, calls, state, input, sourceId, helperStarted, helperClosed } = fixture()
        try {
            await service.startThread({ cwd: '/repo' }, { text: input, clientId: 'first' })
            await helperStarted.promise
            await service.control(sourceId, 'thread/name/set', { name: 'Name set in HAPI' })
            await helperClosed.promise
            expect(calls.filter(call => call.method === 'thread/name/set')).toEqual([
                { method: 'thread/name/set', params: { threadId: sourceId, name: 'Name set in HAPI' } },
            ])
            expect(calls.find(call => call.method === 'turn/interrupt')?.params).toEqual({ threadId: 'helper', turnId: 'helper-turn' })
            expect(state.name).toBe('Name set in HAPI')
        } finally { service.dispose() }
    })

    test('an explicit HAPI rename wins over a daemon write already in flight', async () => {
        const { service, calls, state, input, sourceId, helperStarted, helperClosed, autoWriteStarted, complete } = fixture()
        const barrier = deferred<void>()
        state.autoWriteBarrier = barrier.promise
        try {
            await service.startThread({ cwd: '/repo' }, { text: input, clientId: 'first' })
            complete(await helperStarted.promise)
            await autoWriteStarted.promise
            const rename = service.control(sourceId, 'thread/name/set', { name: 'Name set in HAPI' })
            expect(calls.filter(call => call.method === 'thread/name/set')).toHaveLength(1)
            barrier.resolve()
            await rename
            await helperClosed.promise
            expect(state.name).toBe('Name set in HAPI')
        } finally {
            barrier.resolve()
            service.dispose()
        }
    })
})
