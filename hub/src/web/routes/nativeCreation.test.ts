import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { NativeService } from '../../codexNative/service'
import { NativeRegistry } from '../../codexNative/registry'
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
    app.route('/api', createCodexNativeRoutes(new NativeRegistry([{ endpoint: 'ws://target', namespace: 'owner', id: 'native', label: 'Native' }], () => service)))
    return { app, calls }
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
})
