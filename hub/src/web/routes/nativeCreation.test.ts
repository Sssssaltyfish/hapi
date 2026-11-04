import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { NativeService } from '../../codexNative/service'
import { NativeRegistry } from '../../codexNative/registry'
import { NativeCatalogEvents } from '../../codexNative/catalogEvents'
import type { NativeConnection, NativeEvent } from '../../codexNative/transport'
import { createCodexNativeRoutes } from './codexNative'
import type { WebAppEnv } from '../middleware/auth'

function fixture(namespace = 'owner') {
    const calls: Array<{ method: string; params: any }> = []
    const service = new NativeService({ endpoint: 'ws://target', namespace: 'owner' })
    service.call = async (method, params) => {
        calls.push({ method, params })
        if (method === 'fs/getMetadata') return { isDirectory: true }
        if (method === 'project/create') return { project: { id: 'saved-project', name: 'Repo', roots: [{ path: 'C:\\Repo' }] } }
        if (method === 'project/list') return { data: [{ id: 'canonical-id', name: 'Repo', roots: [{ path: 'C:\\Repo' }] }], nextCursor: 'more' }
        if (method === 'fs/readDirectory') return { entries: [{ fileName: 'Repo', isDirectory: true }, { fileName: '.hidden', isDirectory: true }, { fileName: 'file.txt', isFile: true }, { fileName: '../escape', isDirectory: true }] }
        return {}
    }
    service.startThread = async params => { calls.push({ method: 'thread/start', params }); return { thread: { id: 'created', cwd: params.cwd, projectId: params.projectId } } }
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', namespace); await next() })
    const registry = new NativeRegistry([{ endpoint: 'ws://target', namespace: 'owner', id: 'native', label: 'Native' }], () => service)
    app.route('/api', createCodexNativeRoutes(registry))
    return { app, calls, service, registry }
}

function catalogFixture(service: NativeService, withCatchup = false) {
    const listeners = new Set<(event: NativeEvent) => void>()
    let closes = 0
    const client = { listeners, connect: async () => {}, close: () => { closes++ } }
    const catalog = new NativeCatalogEvents(() => client as unknown as NativeConnection)
    service.subscribeCatalog = (listener, observer) => catalog.subscribe(listener, { ...observer, ...withCatchup ? {} : { connected: undefined } })
    return { emit: (event: NativeEvent) => { for (const listener of listeners) listener(event) }, closes: () => closes }
}

describe('Native creation routes', () => {
    test('uses daemon project identity and roots without treating cwd as an ID', async () => {
        const { app, calls } = fixture()
        const list = await app.request('/api/codex-native/endpoints/native/projects?cursor=previous')
        expect(await list.json()).toMatchObject({ data: [{ id: 'canonical-id' }], nextCursor: 'more' })
        const created = await app.request('/api/codex-native/endpoints/native/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Repo', path: 'C:\\Repo', idempotencyKey: 'stable' }) })
        expect(created.status).toBe(201)
        expect(calls.find(call => call.method === 'project/create')?.params).toEqual({ name: 'Repo', roots: [{ path: 'C:\\Repo' }], idempotencyKey: 'stable' })
        for (const projectId of ['canonical-id', null]) {
            const response = await app.request('/api/codex-native/endpoints/native/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: 'C:\\Execution', projectId }) })
            expect(response.status).toBe(200)
            expect(calls.filter(call => call.method === 'thread/start').at(-1)?.params).toMatchObject({ cwd: 'C:\\Execution', projectId, threadSource: 'user' })
        }
    })
    test('browses Windows directories on the selected daemon and filters unsafe names', async () => {
        const { app, calls } = fixture()
        const result = await app.request('/api/codex-native/endpoints/native/directory?path=C%3A%5CUsers')
        expect(await result.json()).toEqual({ path: 'C:\\Users', parentPath: 'C:\\', entries: [{ fileName: 'Repo', path: 'C:\\Users\\Repo' }], truncated: false })
        expect(calls).toEqual([{ method: 'fs/readDirectory', params: { path: 'C:\\Users' } }])
        expect((await app.request('/api/codex-native/endpoints/native/directory?path=relative')).status).toBe(400)
        expect((await fixture('other').app.request('/api/codex-native/endpoints/native/projects')).status).toBe(404)
    })
    test('uses bounded project pages and validates page inputs before RPC', async () => {
        const { app, calls } = fixture()
        const response = await app.request('/api/codex-native/endpoints/native/projects?limit=7&cursor=before')
        expect(response.status).toBe(200)
        expect(calls).toEqual([{ method: 'project/list', params: { limit: 7, cursor: 'before' } }])
        for (const invalid of ['0', '101', '1.5', 'NaN']) {
            expect((await app.request(`/api/codex-native/endpoints/native/projects?limit=${invalid}`)).status).toBe(400)
        }
        expect(calls).toHaveLength(1)
    })
    test('moves, removes, and renames using daemon acknowledgments before updating local display state', async () => {
        const { app, calls, service, registry } = fixture()
        const observed: unknown[] = []
        registry.observeThread = async (_namespace, _endpoint, thread) => { observed.push(thread) }
        registry.observeProject = async (_namespace, _endpoint, project) => { observed.push(project) }
        service.call = async (method, params) => {
            calls.push({ method, params })
            const p = params as any
            if (method === 'thread/metadata/update') return { thread: { id: p.threadId, projectId: p.projectId || null, cwd: '/same' } }
            if (method === 'project/update') return { project: { id: p.projectId, name: p.name, roots: [{ path: '/same' }] } }
            throw Error('Unexpected RPC')
        }
        for (const projectId of ['new-project', null]) {
            const response = await app.request('/api/codex-native/endpoints/native/threads/thread/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }) })
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ thread: { id: 'thread', projectId } })
        }
        const renamed = await app.request('/api/codex-native/endpoints/native/projects/new-project', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '  Renamed  ' }) })
        expect(renamed.status).toBe(200)
        expect(calls).toEqual([
            { method: 'thread/metadata/update', params: { threadId: 'thread', projectId: 'new-project' } },
            { method: 'thread/metadata/update', params: { threadId: 'thread', projectId: '' } },
            { method: 'project/update', params: { projectId: 'new-project', name: 'Renamed' } },
        ])
        expect(observed).toHaveLength(3)
        registry.observeProject = async () => { throw Error('display storage unavailable') }
        const confirmed = await app.request('/api/codex-native/endpoints/native/projects/new-project', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Confirmed' }) })
        expect(confirmed.status).toBe(200)
        expect(await confirmed.json()).toMatchObject({ project: { name: 'Confirmed' }, displayTrackingError: expect.any(String) })
    })
    test('lazily pages project and unassigned members without flattening native source classification', async () => {
        const { app, calls, service, registry } = fixture()
        const observed: unknown[] = []
        registry.observeThreads = async (_namespace, _endpoint, threads) => { observed.push(...threads) }
        service.call = async (method, params) => {
            calls.push({ method, params })
            return { data: [{ id: 'human', projectId: (params as any).projectId, source: 'appServer', threadSource: 'user' }, { id: 'child', source: 'subAgent', parentThreadId: 'parent' }], nextCursor: 'next-page' }
        }
        const page = await app.request('/api/codex-native/endpoints/native/projects/p/threads?limit=7&cursor=previous')
        expect(await page.json()).toEqual({ data: [{ id: 'human', projectId: 'p', source: 'appServer', threadSource: 'user' }], nextCursor: 'next-page' })
        const unassigned = await app.request('/api/codex-native/endpoints/native/projectless/threads?limit=1')
        expect(unassigned.status).toBe(200)
        expect(calls).toHaveLength(2)
        expect(calls[0]).toMatchObject({ method: 'thread/list', params: { projectId: 'p', cursor: 'previous', limit: 7 } })
        expect(calls[1]).toMatchObject({ method: 'thread/list', params: { projectId: null, limit: 1 } })
        expect(observed).toHaveLength(2)
    })
    test('reports an unconfirmed mutation once without changing the local cache', async () => {
        const { app, calls, service, registry } = fixture()
        let observes = 0
        registry.observeThread = async () => { observes++ }
        service.call = async (method, params) => { calls.push({ method, params }); throw Error('Connection closed after request') }
        const response = await app.request('/api/codex-native/endpoints/native/threads/thread/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'p' }) })
        expect(response.status).toBe(502)
        expect(await response.json()).toMatchObject({ outcome: 'unconfirmed' })
        expect(calls).toHaveLength(1)
        expect(observes).toBe(0)
    })
    test('observes catalog updates before SSE delivery and releases when the reader leaves', async () => {
        const { app, calls, service, registry } = fixture()
        const observed: string[] = []
        const catalog = catalogFixture(service)
        let releaseLocal = 0, allowObservation: (() => void) | undefined
        let localChange: (() => void) | undefined
        const observation = new Promise<void>(resolve => { allowObservation = resolve })
        registry.observeCatalogEvent = async (_namespace, _endpoint, event) => {
            observed.push(event.method)
            if (event.method === 'project/changed') await observation
        }
        registry.subscribeVisibility = (_namespace, _endpoint, listener) => {
            localChange = listener
            return () => { releaseLocal++ }
        }
        const response = await app.request('/api/codex-native/endpoints/native/catalog/events')
        expect(response.headers.get('Content-Type')).toBe('text/event-stream')
        const reader = response.body!.getReader(), decoder = new TextDecoder()
        expect(decoder.decode((await reader.read()).value)).toContain('hapi/catalogReady')
        catalog.emit({ method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } })
        let delivered = false
        const next = reader.read().then(value => { delivered = true; return value })
        await Promise.resolve()
        expect(delivered).toBe(false)
        allowObservation!()
        expect(decoder.decode((await next).value)).toContain('project/changed')
        expect(observed).toEqual(['project/changed'])
        localChange!()
        expect(decoder.decode((await reader.read()).value)).toContain('hapi/visibility/updated')
        await reader.cancel()
        expect(catalog.closes()).toBe(1)
        expect(releaseLocal).toBe(1)
        expect(calls).toHaveLength(0)
    })
    test('closes a disconnected catalog promptly even when an earlier metadata refresh is pending', async () => {
        const { app, service, registry } = fixture()
        const catalog = catalogFixture(service)
        let finish: (() => void) | undefined
        const pending = new Promise<void>(resolve => { finish = resolve })
        registry.observeCatalogEvent = async (_namespace, _endpoint, event) => {
            if (event.method === 'project/changed') await pending
        }
        registry.subscribeVisibility = () => () => {}
        const response = await app.request('/api/codex-native/endpoints/native/catalog/events')
        const reader = response.body!.getReader(), decoder = new TextDecoder()
        await reader.read()
        catalog.emit({ method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } })
        await Promise.resolve()
        catalog.emit({ method: 'hapi/disconnected' })
        expect(decoder.decode((await reader.read()).value)).toContain('hapi/disconnected')
        expect((await reader.read()).done).toBe(true)
        expect(catalog.closes()).toBe(1)
        finish!()
    })
    test('starts bootstrap reconciliation once for a shared observer and keeps ready immediate', async () => {
        const { app, service, registry } = fixture()
        const catalog = catalogFixture(service, true)
        let snapshots = 0
        registry.trackedDirectorySnapshot = async () => { snapshots++; return { threadIds: [], projectIds: [], versions: {} } }
        registry.subscribeVisibility = () => () => {}
        const first = await app.request('/api/codex-native/endpoints/native/catalog/events')
        const firstReader = first.body!.getReader(), decoder = new TextDecoder()
        expect(decoder.decode((await firstReader.read()).value)).toContain('"freshConnection":true')
        const second = await app.request('/api/codex-native/endpoints/native/catalog/events')
        const secondReader = second.body!.getReader()
        expect(decoder.decode((await secondReader.read()).value)).toContain('"freshConnection":false')
        await Promise.resolve()
        expect(snapshots).toBe(1)
        await firstReader.cancel(); await secondReader.cancel()
        expect(catalog.closes()).toBe(1)
    })
})
