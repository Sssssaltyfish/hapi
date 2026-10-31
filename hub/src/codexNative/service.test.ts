import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { NativeService, fallbackThread } from './service'
import type { NativeConnection, NativeEvent } from './transport'
import { createCodexNativeRoutes } from '../web/routes/codexNative'
import type { WebAppEnv } from '../web/middleware/auth'

class FakeConnection {
    async connect(): Promise<void> {}
    listeners = new Set<(event: NativeEvent) => void>()
    requests = new Map()
    calls: Array<{ method: string; params: unknown }> = []
    closed = false
    latestStatus = 'completed'
    runtimeStatus = 'idle'
    itemsUnavailable = false
    queueEmpty = false
    startFailure?: string
    nativeSettings = {
        approvalPolicy: { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } } as unknown,
        approvalsReviewer: 'auto_review',
        sandboxPolicy: { type: 'readOnly' },
    }
    async request(method: string, params: unknown): Promise<unknown> {
        this.calls.push({ method, params })
        if (method === 'thread/start')
            return {
                model: 'model',
                reasoningEffort: 'low',
                thread: { id: 'thread', cwd: '/repo', status: { type: 'idle' }, turns: [] },
            }
        if (method === 'thread/items/list') {
            if (this.itemsUnavailable) throw new Error('thread/items/list is not supported yet')
            return {
                data: [
                    {
                        turnId: 't',
                        item: { id: 'i', type: 'agentMessage', text: 'latest' },
                        startedAtMs: 123,
                    },
                ],
                nextCursor: 'older',
                backwardsCursor: 'newer',
            }
        }
        if (method === 'thread/resume')
            return {
                ...this.nativeSettings,
                model: 'model',
                reasoningEffort: 'low',
                thread: { id: 'thread', turns: [], status: { type: 'idle' } },
            }
        if (method === 'thread/settings/update') {
            Object.assign(this.nativeSettings, params)
            this.emit({
                method: 'thread/settings/updated',
                params: { threadId: 'thread', threadSettings: { ...this.nativeSettings, ...params as object } },
            })
            return {}
        }
        if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queued' } }
        if (method === 'thread/queue/list')
            return { data: this.queueEmpty ? [] : [{ id: 'queued' }] }
        if (method === 'thread/queue/start' && this.startFailure) throw new Error(this.startFailure)
        if (method === 'thread/turns/list')
            return { data: [{ id: 'turn', status: this.latestStatus, items: [] }] }
        if (method === 'thread/read')
            return { thread: { id: 'thread', status: { type: this.runtimeStatus } } }
        return { data: [] }
    }
    emit(event: NativeEvent) {
        for (const listener of this.listeners) listener(event)
    }
    close() {
        this.closed = true
        this.emit({ method: 'hapi/disconnected' })
        this.listeners.clear()
    }
}
function fixture() {
    const clients: FakeConnection[] = []
    const service = new NativeService(
        { endpoint: 'unix:///existing.sock', namespace: 'owner' },
        () => {
            const client = new FakeConnection()
            clients.push(client)
            return client as unknown as NativeConnection
        }
    )
    return { service, clients }
}
function routes(service: NativeService, namespace: string) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        return next()
    })
    app.route('/api', createCodexNativeRoutes(service))
    return app
}
describe('native bridge boundaries', () => {
    test('reads and cancels the daemon queue directly with namespace isolation', async () => {
        const { service, clients } = fixture()
        const app = routes(service, 'owner')
        expect((await app.request('/api/codex-native/threads/thread/queue?cursor=page-two&limit=100')).status).toBe(200)
        expect(clients[0].calls).toEqual([{ method: 'thread/queue/list', params: { threadId: 'thread', cursor: 'page-two', limit: 100 } }])
        const response = await app.request('/api/codex-native/threads/thread/queue/delete', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queuedSubmissionId: 'native-queued-id' }) })
        expect(response.status).toBe(200)
        expect(clients[1].calls).toEqual([{ method: 'thread/queue/delete', params: { threadId: 'thread', queuedSubmissionId: 'native-queued-id' } }])
        expect((await routes(service, 'other').request('/api/codex-native/threads/thread/queue')).status).toBe(404)
    })
    test('Windows exact membership skips Git and optional Git timeout preserves known membership', async () => {
        const state = { 'local-projects': { p: { id: 'p', name: 'Project', rootPaths: ['C:/Repo'] } }, 'projectless-thread-ids': ['manual'] }
        for (const unresolved of [false, true]) {
            const calls: string[] = []
            const service = new NativeService({ endpoint: 'ws://windows', desktopHostId: 'local' })
            service.desktop = async () => ({ state, projects: [{ id: 'p', name: 'Project', path: 'C:/Repo' }], membership: 'desktop' })
            service.call = async (method) => {
                calls.push(method)
                if (method === 'command/exec') {
                    await new Promise((resolve) => setTimeout(resolve, 25))
                    throw new Error('Native directory operation timed out')
                }
                return { data: [
                    { id: 'known', source: 'vscode', cwd: 'c:/repo' },
                    { id: 'manual', source: 'vscode', cwd: 'C:/Unrelated' },
                    { id: 'child', source: 'vscode', cwd: 'C:/Child', parentThreadId: 'parent' },
                    ...(unresolved ? [{ id: 'unknown', source: 'vscode', cwd: 'C:/Unknown' }] : []),
                ] }
            }
            const result = await service.catalog({ limit: 20, deadline: Date.now() + 20 })
            expect((result.data as Array<{ id: string }>).map((thread) => thread.id)).toEqual(['known'])
            expect(calls.filter((method) => method === 'command/exec')).toHaveLength(unresolved ? 2 : 0)
        }
    })
    test('interrupted queue reconciliation handles consumed input without hiding real start failures or replaying acceptance', async () => {
        for (const scenario of [
            { runtime: 'active', empty: false, failure: undefined, starts: 0, error: undefined },
            { runtime: 'idle', empty: true, failure: undefined, starts: 0, error: undefined },
            {
                runtime: 'idle',
                empty: false,
                failure: 'queue is empty',
                starts: 1,
                error: undefined,
            },
            {
                runtime: 'idle',
                empty: false,
                failure: 'Native execution denied',
                starts: 1,
                error: 'Native execution denied',
            },
        ]) {
            const clients: FakeConnection[] = []
            const service = new NativeService(
                { endpoint: 'unix:///existing', namespace: 'owner' },
                () => {
                    const client = new FakeConnection()
                    client.latestStatus = 'interrupted'
                    client.runtimeStatus = scenario.runtime
                    client.queueEmpty = scenario.empty
                    client.startFailure = scenario.failure
                    clients.push(client)
                    return client as unknown as NativeConnection
                }
            )
            const response = await routes(service, 'owner').request(
                '/api/codex-native/threads/thread/messages',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: 'hello', clientId: 'stable' }),
                }
            )
            const body = (await response.json()) as { accepted: boolean; startError?: string }
            expect(body.accepted).toBe(true)
            expect(body.startError).toBe(scenario.error)
            const calls = clients.flatMap((client) => client.calls)
            expect(calls.filter((call) => call.method === 'thread/queue/add')).toHaveLength(1)
            expect(calls.filter((call) => call.method === 'thread/queue/start')).toHaveLength(
                scenario.starts
            )
        }
    })
    test('directory deadline closes its initializing connection without releasing an active thread subscription', async () => {
        const clients: FakeConnection[] = []
        let rejectConnect: ((error: Error) => void) | undefined
        const service = new NativeService(
            { endpoint: 'unix:///existing', namespace: 'owner' },
            () => {
                const client = new FakeConnection()
                if (clients.length) {
                    client.connect = () =>
                        new Promise<void>((_, reject) => {
                            rejectConnect = reject
                        })
                    const close = client.close.bind(client)
                    client.close = () => {
                        close()
                        rejectConnect?.(new Error('Native directory operation timed out'))
                    }
                }
                clients.push(client)
                return client as unknown as NativeConnection
            }
        )
        const release = await service.subscribe('thread', () => {})
        await expect(service.call('thread/list', { limit: 1 }, Date.now() + 20)).rejects.toThrow(
            'timed out'
        )
        expect(clients[1].closed).toBe(true)
        expect(clients[0].closed).toBe(false)
        expect(clients[1].calls).toEqual([])
        release()
        service.dispose()
    })
    test('unauthorized namespace cannot read or attach native threads', async () => {
        const { service, clients } = fixture(),
            app = routes(service, 'other')
        expect((await app.request('/api/codex-native/threads/thread/items')).status).toBe(404)
        expect(await (await app.request('/api/codex-native/status')).json()).toMatchObject({
            enabled: false,
        })
        expect(clients).toHaveLength(0)
    })
    test('native item pagination preserves cursors/timestamps and never resumes a thread', async () => {
        const { service, clients } = fixture()
        const response = await routes(service, 'owner').request(
            '/api/codex-native/threads/thread/items?limit=500&cursor=opaque'
        )
        expect(await response.json()).toMatchObject({
            nextCursor: 'older',
            backwardsCursor: 'newer',
            data: [{ startedAtMs: 123 }],
        })
        expect(clients[0].calls).toEqual([
            {
                method: 'thread/items/list',
                params: { threadId: 'thread', cursor: 'opaque', limit: 100, sortDirection: 'desc' },
            },
        ])
        expect(clients[0].closed).toBe(true)
    })
    test('visible subscriptions attach with no turns, isolate events, and replace failed connections', async () => {
        const { service, clients } = fixture(),
            events: NativeEvent[] = []
        const release = await service.subscribe('thread', (event) => events.push(event))
        expect(clients[0].calls).toEqual([
            { method: 'thread/resume', params: { threadId: 'thread', excludeTurns: true } },
        ])
        clients[0].emit({ method: 'item/started', params: { threadId: 'sibling' } })
        expect(events).toHaveLength(1)
        clients[0].close()
        const releaseNew = await service.subscribe('thread', () => {})
        expect(clients).toHaveLength(2)
        release()
        releaseNew()
        clients[1].close()
    })
    test('fallback excludes ambiguous agent-started and background sources', () => {
        expect(fallbackThread({ source: 'vscode', threadSource: 'agent_created_thread' })).toBe(
            false
        )
        expect(fallbackThread({ source: 'exec' })).toBe(false)
        expect(fallbackThread({ source: 'vscode', parentThreadId: 'p' })).toBe(false)
        expect(fallbackThread({ source: 'vscode' })).toBe(true)
    })
    test('same settings confirm from native snapshot without waiting for a suppressed notification', async () => {
        const { service, clients } = fixture()
        expect(await service.settings('thread', { model: 'model', effort: 'low' })).toMatchObject({
            applied: { model: 'model', effort: 'low' },
        })
        expect(clients[0].calls.map((c) => c.method)).toEqual(['thread/resume'])
        expect(await service.settings('thread', { effort: 'medium' })).toMatchObject({
            applied: { effort: 'medium' },
        })
        expect(clients[1].calls.map((c) => c.method)).toEqual([
            'thread/resume',
            'thread/settings/update',
        ])
    })
    test('native approval controls preserve custom policy and sandbox while routing review separately', async () => {
        const { service, clients } = fixture()
        const response = await routes(service, 'owner').request('/api/codex-native/threads/thread/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvalsReviewer: 'user' }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ applied: {
            approvalsReviewer: 'user', approvalPolicy: { granular: { sandbox_approval: true } },
            sandboxPolicy: { type: 'readOnly' },
        } })
        expect(clients[0].calls.at(-1)).toEqual({
            method: 'thread/settings/update', params: { threadId: 'thread', approvalsReviewer: 'user' },
        })
        expect(await service.settings('thread', { approvalsReviewer: 'auto_review' })).toMatchObject({ applied: { approvalsReviewer: 'auto_review' } })
        expect(clients[1].calls.map(call => call.method)).toEqual(['thread/resume'])
        for (const patch of [
            { approvalPolicy: 'on-failure' }, { approvalsReviewer: 'automatic' },
            { sandboxPolicy: { type: 'dangerFullAccess' } },
        ]) {
            const invalid = await routes(service, 'owner').request('/api/codex-native/threads/thread/settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
            })
            expect(invalid.status).toBe(400)
        }
        expect(clients).toHaveLength(2)
    })
    test('explicit empty thread creation retains its native owner for settings and viewing without a second resume', async () => {
        const { service, clients } = fixture()
        await service.startThread({ cwd: '/repo', model: 'model' })
        expect(await service.settings('thread', { effort: 'medium' })).toMatchObject({
            applied: { effort: 'medium' },
        })
        expect(await service.settings('thread', { effort: 'medium' })).toMatchObject({
            applied: { effort: 'medium' },
        })
        const release = await service.subscribe('thread', () => {})
        expect(clients).toHaveLength(1)
        expect(clients[0].calls.map((c) => c.method)).toEqual([
            'thread/start',
            'thread/settings/update',
        ])
        expect(clients[0].closed).toBe(false)
        clients[0].itemsUnavailable = true
        // The history request uses a disposable connection, while only a native
        // creating owner can establish that an unmaterialized thread is empty.
        const originalCall = service.control.bind(service)
        service.control = async (id, method, params) =>
            method === 'thread/items/list'
                ? clients[0].request(method, params)
                : originalCall(id, method, params)
        expect(await service.items('thread', { limit: 50 })).toEqual({
            data: [],
            nextCursor: null,
            backwardsCursor: null,
        })
        clients[0].emit({ method: 'turn/started', params: { threadId: 'thread' } })
        await expect(service.items('thread', { limit: 50 })).rejects.toThrow('not supported yet')
        release()
        clients[0].close()
    })
    test('ordinary queued input relies on native automatic scheduling without a racy explicit start', async () => {
        const { service, clients } = fixture()
        const response = await routes(service, 'owner').request(
            '/api/codex-native/threads/thread/messages',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', clientId: 'stable' }),
            }
        )
        expect(await response.json()).toMatchObject({
            queuedSubmission: { id: 'queued' },
            accepted: true,
        })
        expect(clients.flatMap((c) => c.calls).map((c) => c.method)).toEqual([
            'thread/queue/add',
            'thread/turns/list',
        ])
    })
    test('interrupted native queue starts without an ID that may already have drained', async () => {
        const clients: FakeConnection[] = []
        const service = new NativeService(
            { endpoint: 'unix:///existing', namespace: 'owner' },
            () => {
                const client = new FakeConnection()
                client.latestStatus = 'interrupted'
                clients.push(client)
                return client as unknown as NativeConnection
            }
        )
        const response = await routes(service, 'owner').request(
            '/api/codex-native/threads/thread/messages',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', clientId: 'stable' }),
            }
        )
        expect(response.status).toBe(200)
        expect(
            clients.flatMap((c) => c.calls).find((c) => c.method === 'thread/queue/start')?.params
        ).toEqual({ threadId: 'thread' })
    })
    test('idle runtime overrides a stale persisted in-progress turn for active forms and interrupt', async () => {
        const clients: FakeConnection[] = []
        const service = new NativeService(
            { endpoint: 'unix:///existing', namespace: 'owner' },
            () => {
                const client = new FakeConnection()
                client.latestStatus = 'inProgress'
                clients.push(client)
                return client as unknown as NativeConnection
            }
        )
        const app = routes(service, 'owner')
        expect(
            await (await app.request('/api/codex-native/threads/thread/active-turn')).json()
        ).toEqual({ activeTurn: null })
        const interrupt = await app.request('/api/codex-native/threads/thread/interrupt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        expect(interrupt.status).toBe(409)
        expect(clients.flatMap((c) => c.calls).some((c) => c.method === 'turn/interrupt')).toBe(
            false
        )
    })
})
