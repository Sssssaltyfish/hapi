import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { SessionsResponse } from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../web/middleware/auth'
import type { SyncEngine } from '../sync/syncEngine'
import { nativeFilePath } from './files'
import { NativeRegistry, configuredNativeEndpoints, nativeSession, nativeSessionId, type NativeEndpointConfig } from './registry'
import { NativeService } from './service'
import { nativeSessionMiddleware } from './sessionMiddleware'
import { createSessionsRoutes } from '../web/routes/sessions'
import { createCodexNativeRoutes } from '../web/routes/codexNative'
import { record, type NativeRecord } from './transport'

const config: NativeEndpointConfig = { id: 'local', label: 'Configured daemon', endpoint: 'unix:///existing.sock', namespace: 'owner', legacyMachineIds: ['wsl'] }
class FakeNative extends NativeService {
    fail = false
    page: NativeRecord = { data: [{ id: 'fork', cwd: '/repo/worktree', name: 'Native title', status: { type: 'idle' }, desktopProject: { id: 'project', name: 'Project', path: '/repo' } }], nextCursor: 'opaque' }
    calls: Array<{ method: string; params: NativeRecord }> = []
    override async readThread(threadId: string): Promise<unknown> {
        this.calls.push({ method: 'thread/read', params: { threadId, includeTurns: false } })
        if (this.fail) throw new Error('Socket unavailable')
        return { thread: { id: threadId, cwd: '/repo', name: 'Native title', status: { type: 'idle' }, model: 'native-model' } }
    }
    override async catalog(params: NativeRecord): Promise<NativeRecord> {
        this.calls.push({ method: 'thread/list', params }); if (this.fail) throw new Error('Socket unavailable'); return this.page
    }
    override async call(method: string, params: unknown): Promise<unknown> {
        this.calls.push({ method, params: record(params) })
        if (method === 'fs/getMetadata') return { isFile: true, isDirectory: false, isSymlink: record(params).path === '/repo/link' }
        return {}
    }
}
function fixture() {
    const native = new FakeNative(config), registry = new NativeRegistry([config], () => native)
    const legacy = nativeSession(config, { id: 'fork', cwd: '/old', name: 'Stale title', model: 'stale-model' })
    legacy.id = 'old-url'; legacy.metadata!.nativeCodex = undefined; legacy.metadata!.machineId = 'wsl'
    legacy.metadata!.codexSourceSessionId = 'origin'
    return { native, registry, legacy }
}
describe('native identities integrated into original sessions', () => {
    test('server endpoint configuration validates workspace and host file access', () => {
        const keys = ['HAPI_CODEX_NATIVE_ENDPOINTS', 'HAPI_CODEX_NATIVE_SOCKET', 'HAPI_CODEX_NATIVE_NAMESPACE', 'HAPI_CODEX_NATIVE_FILE_ACCESS'] as const
        const previous = keys.map(key => process.env[key])
        try {
            for (const fileAccess of ['workspace', 'host'] as const) {
                process.env.HAPI_CODEX_NATIVE_ENDPOINTS = JSON.stringify([{ ...config, fileAccess }])
                expect(configuredNativeEndpoints()[0].fileAccess).toBe(fileAccess)
            }
            process.env.HAPI_CODEX_NATIVE_ENDPOINTS = JSON.stringify([{ ...config, fileAccess: 'all' }])
            expect(() => configuredNativeEndpoints()).toThrow()
            delete process.env.HAPI_CODEX_NATIVE_ENDPOINTS
            process.env.HAPI_CODEX_NATIVE_SOCKET = 'unix:///existing.sock'
            process.env.HAPI_CODEX_NATIVE_NAMESPACE = 'owner'
            process.env.HAPI_CODEX_NATIVE_FILE_ACCESS = 'host'
            expect(configuredNativeEndpoints()[0].fileAccess).toBe('host')
            process.env.HAPI_CODEX_NATIVE_FILE_ACCESS = 'all'
            expect(() => configuredNativeEndpoints()).toThrow()
        } finally {
            keys.forEach((key, index) => {
                if (previous[index] === undefined) delete process.env[key]
                else process.env[key] = previous[index]
            })
        }
    })
    test('same-namespace aliases use current fork identity and fresh native metadata', async () => {
        const { registry, native, legacy } = fixture()
        const result = await registry.resolve('owner', legacy.id, legacy)
        expect(result).toMatchObject({ id: nativeSessionId('local', 'fork'), model: 'native-model', thinking: false, metadata: { name: 'Native title', nativeCodex: { endpointId: 'local', threadId: 'fork' } } })
        expect(native.calls[0].params.threadId).toBe('fork')
        expect(registry.alias({ ...legacy, namespace: 'other' }, 'owner')).toBeUndefined()
        expect(registry.alias({ ...legacy, metadata: { ...legacy.metadata!, machineId: 'unrelated' } }, 'owner')).toBeUndefined()
    })
    test('configured endpoints remain namespace isolated for discovery and path-selected file or creation routes', async () => {
        const native = new FakeNative(config)
        const foreign = { ...config, id: 'foreign', namespace: 'other' }
        const registry = new NativeRegistry([config, foreign], () => native)
        const app = new Hono<WebAppEnv>()
        app.use('*', (c, next) => { c.set('namespace', 'owner'); return next() })
        app.route('/api', createCodexNativeRoutes(registry))
        expect(await (await app.request('/api/codex-native/endpoints')).json()).toEqual({ endpoints: [{ id: 'local', label: 'Configured daemon', address: 'unix:///existing.sock', source: 'env' }] })
        expect((await app.request('/api/codex-native/endpoints/foreign/threads/fork/file?path=README.md')).status).toBe(404)
        expect((await app.request('/api/codex-native/endpoints/foreign/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"cwd":"/repo"}' })).status).toBe(404)
        expect(native.calls).toHaveLength(0)
    })
    test('offline aliases stay native and never fall back to stored harness state', async () => {
        const { registry, native, legacy } = fixture(); native.fail = true
        expect(await registry.resolve('owner', legacy.id, legacy)).toMatchObject({ id: nativeSessionId('local', 'fork'), active: false, thinking: false, metadata: { nativeCodex: { available: false, error: 'Socket unavailable' } } })
    })
    test('catalog does not inject aliases outside native membership or revive archived records', async () => {
        const { registry, native, legacy } = fixture()
        native.page = { data: [], nextCursor: 'older' }
        const result = await registry.list('owner', [legacy], { endpointId: 'local', projectId: 'different', catalog: 'background' })
        expect(result.sessions).toEqual([])
        expect(result.nativePagination).toEqual([{ endpointId: 'local', nextCursor: 'older', available: true }])
        expect(native.calls[0].params).toMatchObject({ projectId: 'different', catalog: 'background', limit: 100 })
    })
    test('project grouping metadata preserves actual native worktree cwd', async () => {
        const { registry, legacy } = fixture()
        const result = await registry.list('owner', [legacy])
        expect(result.sessions).toHaveLength(1)
        expect(result.sessions[0].metadata).toMatchObject({ path: '/repo/worktree', nativeCodex: { projectPath: '/repo', projectName: 'Project' } })
        expect(nativeSession(config, { id: 'unnamed', preview: 'Native preview title' }).metadata?.name).toBe('Native preview title')
    })
    test('endpoint pagination keeps the requested page size aligned with its native cursor', async () => {
        const { registry, native, legacy } = fixture()
        const threads = Array.from({ length: 120 }, (_, index) => ({ id: `thread-${index}`, cwd: '/repo', updatedAt: index }))
        native.catalog = async params => {
            native.calls.push({ method: 'thread/list', params })
            const offset = params.cursor ? Number(String(params.cursor).slice('cursor-'.length)) : 0
            const limit = Number(params.limit)
            return { data: threads.slice(offset, offset + limit), nextCursor: offset + limit < threads.length ? `cursor-${offset + limit}` : null }
        }
        const other = { ...legacy, id: 'claude-session', metadata: { ...legacy.metadata!, flavor: 'claude' } }
        const engine = {
            getSessionsByNamespace: () => [legacy, other],
            getFutureScheduledMessageCounts: () => new Map(),
            getNextScheduledAtBySessionIds: () => new Map()
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', (c, next) => { c.set('namespace', 'owner'); return next() })
        app.route('/api', createSessionsRoutes(() => engine, registry))
        const ids: string[] = []
        let cursor: string | null = null
        for (const expectedCount of [50, 50, 20]) {
            const query = new URLSearchParams({ nativeEndpointId: 'local', limit: '50' })
            if (cursor) query.set('nativeCursor', cursor)
            const page = await (await app.request(`/api/sessions?${query}`)).json() as SessionsResponse
            expect(page.sessions).toHaveLength(expectedCount)
            expect(page.sessions.every(session => session.metadata?.nativeCodex?.endpointId === 'local')).toBe(true)
            ids.push(...page.sessions.map(session => session.id))
            cursor = page.nativePagination?.[0].nextCursor ?? null
        }
        expect(cursor).toBeNull()
        expect(new Set(ids).size).toBe(threads.length)
        expect(ids.sort()).toEqual(threads.map(thread => nativeSessionId('local', thread.id)).sort())
        expect(native.calls.every(call => call.params.limit === 50)).toBe(true)
    })
    test('limited aggregate previews preserve ordering and scheduled counts without exposing a truncated native cursor', async () => {
        const { registry, legacy } = fixture()
        const other = { ...legacy, id: 'claude-session', updatedAt: 1, globalPinned: true, metadata: { ...legacy.metadata!, flavor: 'claude' } }
        const engine = { getSessionsByNamespace: () => [legacy, other], getFutureScheduledMessageCounts: () => new Map([['claude-session', 2]]), getNextScheduledAtBySessionIds: () => new Map([['claude-session', 1234]]) } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', (c, next) => { c.set('namespace', 'owner'); return next() })
        app.route('/api', createSessionsRoutes(() => engine, registry))
        const pinned = await (await app.request('/api/sessions?limit=1')).json() as SessionsResponse
        expect(pinned.sessions).toHaveLength(1)
        expect(pinned.nativePagination).toBeUndefined()
        expect(pinned.sessions[0]).toMatchObject({ id: 'claude-session', futureScheduledMessageCount: 2, nextScheduledAt: 1234 })
        const recent = await (await app.request('/api/sessions?limit=1&order=updatedAt')).json() as SessionsResponse
        expect(recent.sessions).toHaveLength(1)
        expect(recent.nativePagination).toBeUndefined()
        expect(recent.sessions[0].id).toBe(nativeSessionId('local', 'fork'))
    })
    test('legacy native message endpoints cannot read or persist a second conversation', async () => {
        const { registry, legacy, native } = fixture()
        const engine = { resolveSessionAccess: (id: string, namespace: string) => id === legacy.id && namespace === legacy.namespace ? { ok: true, session: legacy, sessionId: id } : { ok: false, reason: 'not-found' } } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', (c, next) => { c.set('namespace', 'owner'); return next() })
        app.use('/api/sessions/*', nativeSessionMiddleware(registry, () => engine))
        app.all('*', c => c.json({ legacyReached: true }))
        expect((await app.request('/api/sessions/old-url/messages')).status).toBe(409)
        expect((await app.request('/api/sessions/old-url/messages', { method: 'POST' })).status).toBe(409)
        expect((await app.request('/api/sessions/codex-native:missing:fork/messages')).status).toBe(404)
        expect((await app.request('/api/sessions/old-url/archive', { method: 'POST' })).status).toBe(200)
        expect(native.calls.at(-1)).toEqual({ method: 'thread/archive', params: { threadId: 'fork' } })
    })
    test('remote file links resolve against the thread and allow daemon-accessible external paths and symlinks', async () => {
        const { native } = fixture()
        for (const [requested, expected] of [['src/file.ts', '/repo/src/file.ts'], ['../handoff.zip', '/handoff.zip'], ['/tmp/handoff.zip', '/tmp/handoff.zip'], ['link', '/repo/link']]) {
            const result = await nativeFilePath(native, { ...config, fileAccess: 'host' }, 'fork', requested)
            expect(result.path).toBe(expected)
            expect(native.calls.at(-1)).toEqual({ method: 'fs/getMetadata', params: { path: expected } })
            if (requested === 'link') expect(result.metadata.isSymlink).toBe(true)
        }
        expect(native.calls.filter(call => call.method === 'fs/getMetadata')).toHaveLength(4)
    })
    test('Windows file links preserve drive and UNC paths outside the thread workspace', async () => {
        const { native } = fixture()
        native.readThread = async () => ({ thread: { cwd: 'C:\\repo' } })
        for (const [requested, expected] of [['src/file.ts', 'C:\\repo\\src\\file.ts'], ['C:\\Users\\owner\\handoff.zip', 'C:\\Users\\owner\\handoff.zip'], ['D:/exports/handoff.zip', 'D:\\exports\\handoff.zip'], ['\\\\server\\share\\handoff.zip', '\\\\server\\share\\handoff.zip']]) {
            expect((await nativeFilePath(native, { ...config, fileAccess: 'host' }, 'fork', requested)).path).toBe(expected)
            expect(native.calls.at(-1)).toEqual({ method: 'fs/getMetadata', params: { path: expected } })
        }
    })
    test('remote file links reject malformed paths and pass through daemon failures', async () => {
        const { native } = fixture()
        for (const requested of ['bad\0path', 'a'.repeat(4097)]) {
            await expect(nativeFilePath(native, config, 'fork', requested)).rejects.toThrow('Invalid file path')
        }
        expect(native.calls.some(call => call.method.startsWith('fs/'))).toBe(false)
        native.call = async () => { throw new Error('Daemon permission denied') }
        await expect(nativeFilePath(native, { ...config, fileAccess: 'host' }, 'fork', '/tmp/handoff.zip')).rejects.toThrow('Daemon permission denied')
    })
    test('workspace file access defaults to scoped paths and rejects symlinks', async () => {
        const { native } = fixture()
        expect((await nativeFilePath(native, config, 'fork', 'src/file.ts')).path).toBe('/repo/src/file.ts')
        await expect(nativeFilePath(native, config, 'fork', '/tmp/handoff.zip')).rejects.toThrow('outside')
        await expect(nativeFilePath(native, { ...config, fileAccess: 'workspace' }, 'fork', '../handoff.zip')).rejects.toThrow('outside')
        await expect(nativeFilePath(native, config, 'fork', 'link/private.txt')).rejects.toThrow('Symbolic')
        expect((await nativeFilePath(native, { ...config, allowedRoots: ['/exports'] }, 'fork', '/exports/handoff.zip')).path).toBe('/exports/handoff.zip')
    })
})
