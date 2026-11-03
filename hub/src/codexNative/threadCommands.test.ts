import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../web/middleware/auth'
import { createCodexNativeRoutes } from '../web/routes/codexNative'
import { NativeService } from './service'
import type { NativeConnection, NativeEvent, NativeRecord } from './transport'
import type { NativeGoal } from '@hapi/protocol/codexThreadCommands'

class Daemon {
    calls: Array<{ method: string; params: NativeRecord }> = []
    clients: Array<{ listeners: Set<(event: NativeEvent) => void> }> = []
    settings: NativeRecord = { model: 'current-model', reasoningEffort: 'high', collaborationMode: {
        mode: 'default', settings: { model: 'current-model', reasoning_effort: 'high', developer_instructions: null }
    } }
    goal: NativeGoal | null = null
    featureFailure = false
    queueFailure = false
    queueMalformed = false
    queued: NativeRecord[] = []
    latestStatus = 'inProgress'
    runtimeStatus = 'active'
    startFailure = false
    emit(event: NativeEvent) {
        for (const client of this.clients) for (const listener of client.listeners) listener(event)
    }
    connection(): NativeConnection {
        const listeners = new Set<(event: NativeEvent) => void>()
        const client = {
            listeners,
            requests: new Map(),
            connect: async () => {},
            request: async (method: string, params: NativeRecord) => {
                this.calls.push({ method, params })
                switch (method) {
                    case 'collaborationMode/list': return { data: [
                        { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
                        { name: 'Default', mode: 'default', model: null, reasoning_effort: null }
                    ] }
                    case 'experimentalFeature/list':
                        if (this.featureFailure) throw new Error('Thread feature discovery unavailable')
                        return params.cursor ? { data: [
                            { name: 'goals', enabled: true, stage: 'stable' },
                            { name: 'collaboration_modes', enabled: false, stage: 'removed' }
                        ], nextCursor: null } : { data: [{ name: 'unrelated', enabled: true }], nextCursor: 'second-page' }
                    case 'thread/resume': return structuredClone({ ...this.settings, thread: { id: 'thread', status: { type: this.runtimeStatus } } })
                    case 'thread/settings/update': {
                        this.settings = { ...this.settings, ...structuredClone(params) }
                        this.emit({ method: 'thread/settings/updated', params: { threadId: 'thread', threadSettings: structuredClone(this.settings) } })
                        return {}
                    }
                    case 'thread/goal/get': return { goal: structuredClone(this.goal) }
                    case 'thread/goal/set': {
                        this.goal = {
                            threadId: 'thread', objective: '', status: 'active', tokenBudget: null,
                            tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2,
                            ...this.goal, ...params
                        } as NativeGoal
                        this.emit({ method: 'thread/goal/updated', params: { threadId: 'thread', turnId: null, goal: structuredClone(this.goal) } })
                        return { goal: structuredClone(this.goal) }
                    }
                    case 'thread/goal/clear': {
                        const cleared = this.goal !== null
                        this.goal = null
                        this.emit({ method: 'thread/goal/cleared', params: { threadId: 'thread' } })
                        return { cleared }
                    }
                    case 'thread/queue/add':
                        if (this.queueFailure) throw new Error('Native queue disconnected')
                        this.queued.push(params)
                        if (this.queueMalformed) return {}
                        return { queuedSubmission: { id: 'queued', clientUserMessageId: params.clientUserMessageId } }
                    case 'thread/turns/list': return { data: [{ id: 'turn', status: this.latestStatus }] }
                    case 'thread/read': return { thread: { id: 'thread', status: { type: this.runtimeStatus } } }
                    case 'thread/queue/list': return { data: this.queued }
                    case 'thread/queue/start':
                        if (this.startFailure) throw new Error('Start confirmation unavailable')
                        return {}
                    default: return { data: [] }
                }
            },
            close: () => {
                for (const listener of listeners) listener({ method: 'hapi/disconnected' })
                listeners.clear()
            }
        }
        this.clients.push(client)
        return client as unknown as NativeConnection
    }
}
function fixture() {
    const daemon = new Daemon()
    const service = new NativeService({ endpoint: 'unix:///fake', namespace: 'owner' }, () => daemon.connection())
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'owner'); await next() })
    app.route('/api', createCodexNativeRoutes(service))
    const command = (value: unknown, extra: NativeRecord = {}) => app.request('/api/codex-native/threads/thread/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: value, ...extra })
    })
    return { daemon, service, app, command }
}

describe('Native Plan and Goal commands', () => {
    test('discovers the thread-specific second feature page and retains authoritative settings notifications', async () => {
        const { daemon, service, app } = fixture()
        const release = await service.subscribe('thread', () => {})
        try {
            const response = await app.request('/api/codex-native/threads/thread/commands')
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ capabilities: { plan: true, goal: true }, collaborationMode: { mode: 'default' }, goal: null })
            expect(daemon.calls.filter(call => call.method === 'experimentalFeature/list').map(call => call.params)).toEqual([
                { threadId: 'thread', limit: 100, cursor: undefined },
                { threadId: 'thread', limit: 100, cursor: 'second-page' }
            ])
            daemon.emit({ method: 'thread/settings/updated', params: { threadId: 'thread', threadSettings: { collaborationMode: { mode: 'plan' } } } })
            expect(await (await app.request('/api/codex-native/threads/thread/commands')).json()).toMatchObject({ collaborationMode: { mode: 'plan' } })
            expect(daemon.calls.filter(call => call.method === 'thread/resume')).toHaveLength(1)
        } finally { release(); service.dispose() }
    })

    test('confirms a native Plan preset with the current model and emits no user input for management commands', async () => {
        const { daemon, service, app, command } = fixture()
        try {
            expect(await (await app.request('/api/codex-native/threads/thread/commands')).json()).toMatchObject({ collaborationMode: null })
            const response = await command({ command: 'plan', mode: 'plan' })
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ command: 'plan', applied: { collaborationMode: {
                mode: 'plan', settings: { model: 'current-model', reasoning_effort: 'medium', developer_instructions: null }
            } } })
            expect(daemon.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(1)
            expect(daemon.calls.some(call => ['thread/queue/add', 'turn/start', 'turn/steer'].includes(call.method))).toBe(false)
            const repeated = await command({ command: 'plan', mode: 'plan' })
            expect(repeated.status).toBe(200)
            expect(daemon.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(1)
        } finally { service.dispose() }
    })

    test('queues Plan input once after settings confirmation and distinguishes an unconfirmed queue write', async () => {
        const { daemon, service, command } = fixture()
        try {
            const response = await command({ command: 'plan', mode: 'plan', prompt: 'Prepare the requested plan' }, { clientId: 'input-id' })
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ submission: { accepted: true, queuedSubmission: { clientUserMessageId: 'input-id' } } })
            expect(daemon.calls.find(call => call.method === 'thread/queue/add')?.params).toMatchObject({
                clientUserMessageId: 'input-id', input: [{ type: 'text', text: 'Prepare the requested plan' }]
            })
            expect(daemon.calls.some(call => call.method === 'turn/steer' || call.method === 'turn/start')).toBe(false)
            daemon.queueFailure = true
            const uncertain = await command({ command: 'plan', mode: 'plan', prompt: 'Another input' }, { clientId: 'uncertain-id' })
            expect(uncertain.status).toBe(502)
            expect(await uncertain.json()).toMatchObject({ applied: { collaborationMode: { mode: 'plan' } }, submission: { accepted: false, outcome: 'unconfirmed', clientId: 'uncertain-id' } })
            expect(daemon.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(2)
            daemon.queueFailure = false
            daemon.queueMalformed = true
            const malformed = await command({ command: 'plan', mode: 'plan', prompt: 'Inspect acceptance' }, { clientId: 'malformed-id' })
            expect(malformed.status).toBe(502)
            expect(await malformed.json()).toMatchObject({ submission: { outcome: 'unconfirmed', clientId: 'malformed-id' } })
        } finally { service.dispose() }
    })

    test('keeps accepted Plan input accepted when an interrupted thread cannot confirm its later start', async () => {
        const { daemon, service, command } = fixture()
        daemon.latestStatus = 'interrupted'
        daemon.runtimeStatus = 'idle'
        daemon.startFailure = true
        try {
            const response = await command({ command: 'plan', mode: 'plan', prompt: 'Next turn' }, { clientId: 'interrupted-id' })
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ submission: { accepted: true, startError: 'Start confirmation unavailable' } })
            expect(daemon.calls.filter(call => call.method === 'thread/queue/add')).toHaveLength(1)
            expect(daemon.calls.filter(call => call.method === 'thread/queue/start')).toHaveLength(1)
        } finally { service.dispose() }
    })

    test('uses explicit user provenance for Goal mutations, preserves accounting, and validates before any mutation', async () => {
        const { daemon, service, app, command } = fixture()
        try {
            expect((await command({ command: 'goal', action: 'set', objective: 'Complete the requested work' })).status).toBe(200)
            daemon.goal!.tokensUsed = 37
            daemon.goal!.tokenBudget = 1000
            expect(await (await command({ command: 'goal', action: 'pause' })).json()).toMatchObject({ goal: { status: 'paused', tokensUsed: 37, tokenBudget: 1000 } })
            expect(await (await command({ command: 'goal', action: 'resume' })).json()).toMatchObject({ goal: { status: 'active', tokensUsed: 37 } })
            expect(await (await command({ command: 'goal', action: 'show' })).json()).toMatchObject({ goal: { objective: 'Complete the requested work' } })
            expect(await (await command({ command: 'goal', action: 'clear' })).json()).toEqual({ command: 'goal', action: 'clear', cleared: true })
            const writes = daemon.calls.filter(call => call.method === 'thread/goal/set' || call.method === 'thread/goal/clear')
            expect(writes).toHaveLength(4)
            expect(writes.every(call => call.params.origin === 'user' && !('tokenBudget' in call.params))).toBe(true)
            expect((await command({ command: 'goal', action: 'set', objective: '😀'.repeat(4000) })).status).toBe(200)
            const previous = daemon.calls.length
            expect((await command({ command: 'goal', action: 'set', objective: 'x'.repeat(4001) })).status).toBe(400)
            expect((await command({ command: 'goal', action: 'set', objective: '😀'.repeat(4001) })).status).toBe(400)
            expect((await command({ command: 'goal', action: 'show' }, { attachments: [{ path: 'keep-draft' }] })).status).toBe(400)
            expect((await app.request('/api/codex-native/threads/thread/commands', { headers: { 'x-test-namespace': 'other' } })).status).toBe(404)
            expect(daemon.calls).toHaveLength(previous)
            expect(daemon.queued).toHaveLength(0)
        } finally { service.dispose() }
    })

    test('degrades when per-thread feature discovery is unavailable without falling back to global enablement', async () => {
        const { daemon, service, app, command } = fixture()
        daemon.featureFailure = true
        try {
            expect(await (await app.request('/api/codex-native/threads/thread/commands')).json()).toMatchObject({ capabilities: { plan: false, goal: false }, collaborationMode: null })
            expect((await command({ command: 'plan', mode: 'plan' })).status).toBe(409)
            expect(daemon.calls.some(call => call.method === 'thread/settings/update' || call.method === 'thread/goal/set')).toBe(false)
        } finally { service.dispose() }
    })
})
