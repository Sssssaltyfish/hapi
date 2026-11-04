import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { NativeRegistry, nativeSession } from './registry'
import { createCodexNativeRoutes } from '../web/routes/codexNative'
import type { WebAppEnv } from '../web/middleware/auth'
import type { NativeService } from './service'
import type { NativeRecord } from './transport'

function fixture(dataDir?: string) {
    const calls: Array<{ method: string; params: NativeRecord }> = []
    let fail = false
    const threads = Array.from({ length: 205 }, (_, i) => ({ id: `member-${i}`, name: `Chat ${i}`, projectId: 'project', cwd: '/repo', updatedAt: i }))
    const config = { id: 'endpoint', namespace: 'owner', label: 'Native', endpoint: 'ws://existing' }
    const service = {
        authorized: (namespace: string) => namespace === 'owner', dispose() {},
        async catalog(params: NativeRecord) {
            calls.push({ method: 'catalog', params }); if (fail) throw Error('Offline')
            return { data: [{ id: 'existing', name: 'Previous visible chat', cwd: '/old' }], nextCursor: 'ignored-global-next-page' }
        },
        async readThread(id: string) { calls.push({ method: 'thread/read', params: { threadId: id } }); return { thread: threads.find(thread => thread.id === id) ?? { id, cwd: '/work' } } },
        async call(method: string, params: NativeRecord) {
            calls.push({ method, params })
            if (method === 'project/read') return { project: { id: params.projectId, name: 'Workspace', roots: [{ path: '/repo' }] } }
            if (method === 'thread/list') {
                const offset = Number(params.cursor ?? 0)
                return { data: threads.slice(offset, offset + 100), nextCursor: offset + 100 < threads.length ? String(offset + 100) : null }
            }
            throw Error(`Unexpected native operation ${method}`)
        },
    } as unknown as NativeService
    const registry = new NativeRegistry([config], () => service, dataDir ? { dataDir } : undefined)
    return { registry, service, calls, config, legacy: nativeSession(config, { id: 'existing', cwd: '/old' }), fail: (value: boolean) => { fail = value } }
}

describe('local native home visibility', () => {
    test('validates local visibility actions and tracks empty creation before returning', async () => {
        const { registry, service, calls } = fixture()
        service.startThread = async () => ({ thread: { id: 'new-empty', cwd: '/work', projectId: null }, model: 'model', reasoningEffort: 'high' })
        const app = new Hono<WebAppEnv>()
        app.use('*', (c, next) => { c.set('namespace', 'owner'); return next() })
        app.route('/api', createCodexNativeRoutes(registry))
        const send = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        expect((await send('/api/codex-native/endpoints/foreign/visibility', { action: 'hide-thread', threadId: 'x' })).status).toBe(404)
        expect((await send('/api/codex-native/endpoints/endpoint/visibility', { action: 'delete-thread', threadId: 'x' })).status).toBe(400)
        expect((await send('/api/codex-native/endpoints/endpoint/threads', { cwd: '/work' })).status).toBe(200)
        expect((await registry.list('owner', [])).sessions.map(session => session.id)).toEqual(['codex-native:endpoint:new-empty'])
        expect((await send('/api/codex-native/endpoints/endpoint/visibility', { action: 'hide-thread', threadId: 'new-empty' })).status).toBe(200)
        expect((await registry.list('owner', [])).sessions).toEqual([])
        expect(calls).toEqual([])
    })
    test('migrates one interactive page once, persists hides, and isolates namespace', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-visibility-'))
        try {
            const f = fixture(dir)
            expect((await f.registry.list('owner', [f.legacy])).sessions.map(session => session.id)).toEqual(['codex-native:endpoint:existing'])
            await f.registry.changeVisibility('owner', 'endpoint', { action: 'hide-thread', threadId: 'existing' })
            expect((await f.registry.list('owner', [])).sessions).toEqual([])
            expect(f.calls.filter(call => call.method === 'catalog')).toHaveLength(1)
            expect(f.calls[0].params).toMatchObject({ limit: 100, boundedMigration: true })
            expect((await f.registry.list('foreign', [])).sessions).toEqual([])
            const reopened = new NativeRegistry([f.config], () => f.service, { dataDir: dir })
            expect((await reopened.list('owner', [])).sessions).toEqual([])
            expect(f.calls.filter(call => call.method === 'catalog')).toHaveLength(1)
        } finally { await rm(dir, { recursive: true, force: true }) }
    })
    test('imports every selected project page and serves all known members without further native reads', async () => {
        const { registry, calls } = fixture()
        let result = await registry.changeVisibility('owner', 'endpoint', { action: 'track-project', projectId: 'project' })
        expect(result.visibility.projects[0]).toMatchObject({ memberCount: 100, complete: false, nextCursor: '100' })
        while (!result.visibility.projects[0].complete) result = await registry.changeVisibility('owner', 'endpoint', { action: 'discover-project', projectId: 'project' })
        expect(result.sessions).toHaveLength(205)
        const beforeHome = calls.length
        expect((await registry.list('owner', [])).sessions).toHaveLength(205)
        expect(calls).toHaveLength(beforeHome)
        expect(calls.filter(call => call.method === 'thread/list').map(call => call.params.cursor ?? null)).toEqual([null, '100', '200'])
        await registry.changeVisibility('owner', 'endpoint', { action: 'hide-thread', threadId: 'member-101' })
        expect((await registry.list('owner', [])).sessions).toHaveLength(204)
        await registry.changeVisibility('owner', 'endpoint', { action: 'track-thread', threadId: 'member-101' })
        expect((await registry.list('owner', [])).sessions).toHaveLength(205)
        await registry.changeVisibility('owner', 'endpoint', { action: 'hide-project', projectId: 'project' })
        expect((await registry.list('owner', [])).sessions).toEqual([])
        await registry.changeVisibility('owner', 'endpoint', { action: 'track-thread', threadId: 'member-101' })
        expect((await registry.list('owner', [])).sessions.map(session => session.id)).toEqual(['codex-native:endpoint:member-101'])
        expect(calls.some(call => /archive|delete|resume|items|turns/.test(call.method))).toBe(false)
    })
    test('tracks new empty chats immediately and observes targeted rename/membership without global discovery', async () => {
        const { registry, calls } = fixture()
        await registry.trackCreated('owner', 'endpoint', { id: 'empty', name: 'New', projectId: null, cwd: '/work' })
        expect((await registry.list('owner', [])).sessions[0].metadata?.nativeCodex?.projectId).toBeUndefined()
        await registry.observeCatalogEvent('owner', 'endpoint', { method: 'thread/project/updated', params: { threadId: 'empty', projectId: 'project' } })
        expect((await registry.list('owner', [])).sessions[0].metadata?.nativeCodex).toMatchObject({ projectId: 'project', projectName: 'Workspace' })
        await registry.observeCatalogEvent('owner', 'endpoint', { method: 'project/changed', params: { projectId: 'untracked' } })
        expect(calls.filter(call => call.method === 'project/read')).toHaveLength(1)
        await registry.observeCatalogEvent('owner', 'endpoint', { method: 'thread/archived', params: { threadId: 'empty' } })
        expect((await registry.list('owner', [])).sessions).toEqual([])
        expect(calls.some(call => call.method === 'catalog')).toBe(false)
    })
    test('keeps a visible project member when the daemon moves it into no workspace', async () => {
        const { registry } = fixture()
        await registry.changeVisibility('owner', 'endpoint', { action: 'track-project', projectId: 'project' })
        await registry.observeCatalogEvent('owner', 'endpoint', { method: 'thread/project/updated', params: { threadId: 'member-0', projectId: null } })
        expect((await registry.list('owner', [])).sessions).toHaveLength(100)
        await registry.changeVisibility('owner', 'endpoint', { action: 'hide-project', projectId: 'project' })
        const remaining = (await registry.list('owner', [])).sessions
        expect(remaining.map(session => session.id)).toEqual(['codex-native:endpoint:member-0'])
        expect(remaining[0].metadata?.nativeCodex?.projectId).toBeUndefined()
    })
    test('groups migrated chats with their workspace and respects an explicit clear even when the daemon ID was already null', async () => {
        const { registry } = fixture()
        const inferred = { id: 'imported', projectId: null, cwd: '/repo', desktopProject: { id: 'desktop', nativeId: 'project', name: 'Workspace', path: '/repo' } }
        await registry.trackCreated('owner', 'endpoint', inferred)
        await registry.trackCreated('owner', 'endpoint', { id: 'assigned', projectId: 'project' })
        await registry.observeProject('owner', 'endpoint', { id: 'project', name: 'Renamed workspace' })
        const { sessions } = await registry.list('owner', [])
        expect(sessions.map(session => session.metadata?.nativeCodex?.projectId)).toEqual(['project', 'project'])
        expect(sessions.every(session => session.metadata?.nativeCodex?.projectName === 'Renamed workspace')).toBe(true)

        await registry.observeCatalogEvent('owner', 'endpoint', { method: 'thread/project/updated', params: { threadId: inferred.id, projectId: null } })
        const snapshot = await registry.trackedDirectorySnapshot('owner', 'endpoint')
        await registry.applyDirectoryReconciliation('owner', 'endpoint', { threads: [inferred] }, snapshot.versions)
        await registry.changeVisibility('owner', 'endpoint', { action: 'hide-project', projectId: 'project' })
        const remaining = (await registry.list('owner', [])).sessions
        expect(remaining.map(session => session.metadata?.nativeCodex)).toEqual([{ endpointId: 'endpoint', threadId: 'imported', available: true }])
    })
    test('does not repeat a failed migration on every home request', async () => {
        const clock = spyOn(Date, 'now').mockReturnValue(100_000)
        try {
            const f = fixture(); f.fail(true)
            expect((await f.registry.list('owner', [f.legacy])).nativePagination[0].available).toBe(false)
            await f.registry.list('owner', [f.legacy])
            expect(f.calls.filter(call => call.method === 'catalog')).toHaveLength(1)
            expect((await f.registry.visibilitySnapshot('owner', 'endpoint')).visibility.initialized).toBe(false)
            clock.mockReturnValue(161_000); f.fail(false)
            expect((await f.registry.list('owner', [f.legacy])).sessions).toHaveLength(1)
            await f.registry.list('owner', [])
            expect(f.calls.filter(call => call.method === 'catalog')).toHaveLength(2)
        } finally { clock.mockRestore() }
    })
    test('a delayed project page cannot undo a local hide and local observers detach cleanly', async () => {
        const { registry, service } = fixture()
        const original = service.call.bind(service)
        let release!: (page: NativeRecord) => void
        let began!: () => void
        const started = new Promise<void>(resolve => { began = resolve })
        const page = new Promise<NativeRecord>(resolve => { release = resolve })
        service.call = async (method, params) => {
            if (method === 'thread/list') { began(); return page }
            return original(method, params)
        }
        let notifications = 0
        const unsubscribe = registry.subscribeVisibility('owner', 'endpoint', () => { notifications++ })
        const importing = registry.changeVisibility('owner', 'endpoint', { action: 'track-project', projectId: 'project' })
        await started
        await registry.changeVisibility('owner', 'endpoint', { action: 'hide-project', projectId: 'project' })
        release({ data: [{ id: 'late', projectId: 'project', cwd: '/repo' }], nextCursor: null })
        expect((await importing).sessions).toEqual([])
        expect(notifications).toBeGreaterThan(0)
        unsubscribe(); const stopped = notifications
        await registry.trackCreated('owner', 'endpoint', { id: 'own-new', cwd: '/work' })
        expect(notifications).toBe(stopped)
    })
    test.each(['move', 'archive'])('a delayed member page cannot undo a newer %s notification', async action => {
        const { registry, service } = fixture()
        await registry.changeVisibility('owner', 'endpoint', { action: 'track-project', projectId: 'project' })
        const original = service.call.bind(service)
        let release!: (value: NativeRecord) => void, began!: () => void
        const started = new Promise<void>(resolve => { began = resolve })
        const response = new Promise<NativeRecord>(resolve => { release = resolve })
        service.call = async (method, params) => {
            if (method === 'thread/list') { began(); return response }
            return original(method, params)
        }
        const loading = registry.changeVisibility('owner', 'endpoint', { action: 'discover-project', projectId: 'project' })
        await started
        await registry.observeCatalogEvent('owner', 'endpoint', action === 'move'
            ? { method: 'thread/project/updated', params: { threadId: 'member-0', projectId: null } }
            : { method: 'thread/archived', params: { threadId: 'member-0' } })
        release({ data: [{ id: 'member-0', projectId: 'project', cwd: '/repo' }], nextCursor: null })
        await loading
        await registry.changeVisibility('owner', 'endpoint', { action: 'hide-project', projectId: 'project' })
        const home = (await registry.list('owner', [])).sessions
        expect(home.map(session => session.id)).toEqual(action === 'move' ? ['codex-native:endpoint:member-0'] : [])
        if (home.length) expect(home[0].metadata?.nativeCodex?.projectId).toBeUndefined()
    })
    test('deleted projects invalidate locally without trying to read the deleted object', async () => {
        const { registry, calls } = fixture()
        await registry.trackCreated('owner', 'endpoint', { id: 'retained', projectId: 'project', cwd: '/repo' })
        const before = calls.length
        await registry.observeCatalogEvent('owner', 'endpoint', { method: 'project/changed', params: { projectId: 'project', changeType: 'deleted' } })
        expect(calls).toHaveLength(before)
        const home = (await registry.list('owner', [])).sessions
        expect(home.map(session => session.id)).toEqual(['codex-native:endpoint:retained'])
        expect(home[0].metadata?.nativeCodex?.projectId).toBeUndefined()
    })
    test('reconnect reconciliation cannot overwrite newer directory events or restore a hidden chat', async () => {
        const { registry } = fixture()
        for (const id of ['a', 'b']) await registry.trackCreated('owner', 'endpoint', { id, name: 'Old', projectId: 'p', source: 'cli' })
        await registry.observeProject('owner', 'endpoint', { id: 'p', name: 'Old workspace', roots: [] })
        const snapshot = await registry.trackedDirectorySnapshot('owner', 'endpoint')
        await registry.observeProject('owner', 'endpoint', { id: 'p', name: 'New workspace', roots: [] })
        await registry.observeThread('owner', 'endpoint', { id: 'a', name: 'New chat', projectId: null })
        await registry.applyDirectoryReconciliation('owner', 'endpoint', {
            threads: [{ id: 'a', name: 'Old', projectId: 'p' }], projects: [{ id: 'p', name: 'Old workspace' }],
        }, snapshot.versions)
        const home = (await registry.list('owner', [])).sessions
        expect(home.find(session => session.id.endsWith(':a'))?.metadata).toMatchObject({ name: 'New chat' })
        expect(home.find(session => session.id.endsWith(':a'))?.metadata?.nativeCodex?.projectId).toBeUndefined()
        expect(home.find(session => session.id.endsWith(':b'))?.metadata?.nativeCodex?.projectName).toBe('New workspace')
        await registry.changeVisibility('owner', 'endpoint', { action: 'hide-thread', threadId: 'b' })
        await registry.applyDirectoryReconciliation('owner', 'endpoint', { threads: [{ id: 'b', name: 'Late read', projectId: 'p' }] }, snapshot.versions)
        expect((await registry.list('owner', [])).sessions.some(session => session.id.endsWith(':b'))).toBe(false)
    })
    test('identical browse/reconnect observations do not write settings, bump versions, or notify subscribers', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-visibility-noop-'))
        try {
            const { registry } = fixture(dir)
            const thread = { id: 'same', name: 'Same', projectId: 'p', source: 'appServer', threadSource: 'user' }
            const project = { id: 'p', name: 'Same workspace', roots: [{ path: '/work' }] }
            await registry.trackCreated('owner', 'endpoint', thread)
            await registry.observeProject('owner', 'endpoint', project)
            const snapshot = await registry.trackedDirectorySnapshot('owner', 'endpoint')
            const before = (await stat(join(dir, 'settings.json'))).mtimeMs
            let notifications = 0
            const release = registry.subscribeVisibility('owner', 'endpoint', () => { notifications++ })
            await new Promise(resolve => setTimeout(resolve, 15))
            await registry.observeThreads('owner', 'endpoint', [thread])
            await registry.observeProject('owner', 'endpoint', project)
            await registry.applyDirectoryReconciliation('owner', 'endpoint', { threads: [thread], projects: [project] }, snapshot.versions)
            expect((await stat(join(dir, 'settings.json'))).mtimeMs).toBe(before)
            expect((await registry.trackedDirectorySnapshot('owner', 'endpoint')).versions).toEqual(snapshot.versions)
            expect(notifications).toBe(0)
            release()
        } finally { await rm(dir, { recursive: true, force: true }) }
    })
})
