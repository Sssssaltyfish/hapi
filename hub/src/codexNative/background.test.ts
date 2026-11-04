import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { NativeRegistry } from './registry'
import type { NativeService } from './service'
import { record, type NativeRecord } from './transport'
import { createCodexNativeRoutes } from '../web/routes/codexNative'
import type { WebAppEnv } from '../web/middleware/auth'

function fixture(legacyRows: NativeRecord[] = []) {
    const rows: NativeRecord[] = [
        { id: 'exec', source: 'exec', projectId: 'p' },
        { id: 'human-cli', source: 'cli', projectId: 'p' },
        { id: 'subagent', source: { subAgent: { thread_spawn: {} } }, projectId: 'q' },
        { id: 'human-app', source: 'appServer', threadSource: 'user', projectId: 'p' },
        { id: 'automatic-app', source: 'appServer', threadSource: 'agent_created_thread', projectId: 'p' },
        { id: 'ephemeral', source: 'appServer', ephemeral: true, projectId: 'p' },
        ...legacyRows,
    ]
    const calls: Array<{ method: string; params: NativeRecord }> = []
    const service = {
        authorized: (namespace: string) => namespace === 'owner',
        async readThread(threadId: string) { calls.push({ method: 'thread/read', params: { threadId } }); return { thread: rows.find(row => row.id === threadId) } },
        async call(method: string, raw: unknown) {
            const params = record(raw); calls.push({ method, params })
            if (method === 'project/read') return { project: { id: params.projectId, name: 'Workspace', roots: [] } }
            if (method !== 'thread/list') throw Error('Unexpected directory call')
            const kinds = params.sourceKinds as string[]
            const candidates = rows.filter(row => (!Object.hasOwn(params, 'projectId') || row.projectId === params.projectId)
                && kinds.includes(typeof row.source === 'string' ? row.source : 'subAgent'))
            const offset = params.cursor ? Number(String(params.cursor).slice(7)) : 0
            const limit = Number(params.limit)
            return { data: candidates.slice(offset, offset + limit), nextCursor: offset + limit < candidates.length ? `native:${offset + limit}` : null }
        },
        async catalog() { throw Error('Fresh home must not enumerate the native catalog') },
    } as unknown as NativeService
    const registry = new NativeRegistry([{ id: 'host', namespace: 'owner', label: 'Host', endpoint: 'ws://existing' }], () => service)
    const app = new Hono<WebAppEnv>()
    app.use('*', (c, next) => { c.set('namespace', 'owner'); return next() })
    app.route('/api', createCodexNativeRoutes(registry))
    return { registry, calls, app }
}

test('fresh home is empty without global catalog or directory RPCs', async () => {
    const { registry, calls } = fixture()
    expect((await registry.list('owner', [])).sessions).toEqual([])
    expect(calls).toEqual([])
})
test('host background directory is lazy, cursor-paged, source-filtered and independent of projects', async () => {
    const { app, calls } = fixture()
    const ids: string[] = []
    let cursor: string | null = null
    do {
        const response = await app.request(`/api/codex-native/endpoints/host/background/threads?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        expect(response.status).toBe(200)
        const page = await response.json() as { data: NativeRecord[]; nextCursor: string | null }
        ids.push(...page.data.map(thread => String(thread.id))); cursor = page.nextCursor
    } while (cursor)
    expect(ids).toEqual(['exec', 'subagent', 'automatic-app', 'ephemeral'])
    expect(calls).toHaveLength(4)
    expect(calls.every(call => call.method === 'thread/list' && !Object.hasOwn(call.params, 'projectId'))).toBe(true)
    expect(calls[0].params.sourceKinds).not.toContain('cli')
    expect(calls[0].params.sourceKinds).toContain('exec')
    expect(calls[3].params.sourceKinds).toEqual(['cli', 'vscode'])
})
test('legacy positive provenance is selectable in a second lazy source phase without importing ordinary chats', async () => {
    const { app, calls } = fixture([
        { id: 'legacy-exec', source: 'cli', originator: 'codex_exec', projectId: 'p' },
        { id: 'legacy-child', source: 'vscode', parentThreadId: 'root', projectId: 'p' },
    ])
    const first = await (await app.request('/api/codex-native/endpoints/host/background/threads?limit=100')).json() as { data: NativeRecord[]; nextCursor: string }
    expect(first.data.map(thread => thread.id)).toEqual(['exec', 'subagent', 'automatic-app', 'ephemeral'])
    expect(calls).toHaveLength(1)
    expect(first.nextCursor).toStartWith('hapi-bg-v1:')
    const ordinary = await (await app.request('/api/codex-native/endpoints/host/projects/p/threads?limit=100')).json() as { data: NativeRecord[] }
    expect(ordinary.data.map(thread => thread.id)).toEqual(['human-cli', 'human-app'])
    let cursor: string | null = first.nextCursor, pages = 0
    const legacy: string[] = []
    do {
        const response = await app.request(`/api/codex-native/endpoints/host/background/threads?limit=1&cursor=${encodeURIComponent(cursor)}`)
        const page = await response.json() as { data: NativeRecord[]; nextCursor: string | null }
        legacy.push(...page.data.map(thread => String(thread.id))); cursor = page.nextCursor
        expect(calls).toHaveLength(2 + ++pages)
        expect(calls.at(-1)?.params.sourceKinds).toEqual(['cli', 'vscode'])
    } while (cursor)
    expect(pages).toBe(3)
    expect(legacy).toEqual(['legacy-exec', 'legacy-child'])
})
test('invalid composite background cursors are rejected before a native request', async () => {
    const { app, calls } = fixture()
    const response = await app.request('/api/codex-native/endpoints/host/background/threads?cursor=hapi-bg-v1:invalid')
    expect(response.status).toBe(400)
    expect(calls).toEqual([])
})
test('ordinary project pages/import exclude automatic work, while explicit background tracking remains allowed', async () => {
    const { registry, app, calls } = fixture()
    const first = await (await app.request('/api/codex-native/endpoints/host/projects/p/threads?limit=2')).json() as { data: NativeRecord[]; nextCursor: string | null }
    expect(first.data.map(thread => thread.id)).toEqual(['human-cli', 'human-app'])
    expect(first.nextCursor).toBe('native:2')
    const second = await (await app.request(`/api/codex-native/endpoints/host/projects/p/threads?limit=2&cursor=${first.nextCursor}`)).json() as { data: NativeRecord[]; nextCursor: string | null }
    expect(second.data).toEqual([])
    expect(second.nextCursor).toBeNull()
    expect(calls[0].params.sourceKinds).not.toContain('exec')
    expect(calls[0].params.sourceKinds).not.toContain('subAgent')
    await registry.changeVisibility('owner', 'host', { action: 'track-project', projectId: 'p' })
    await registry.observeThread('owner', 'host', { id: 'future-auto', projectId: 'p', source: 'exec' })
    expect((await registry.list('owner', [])).sessions.map(session => session.id).sort()).toEqual(['codex-native:host:human-app', 'codex-native:host:human-cli'])
    await registry.changeVisibility('owner', 'host', { action: 'track-thread', threadId: 'exec' })
    expect((await registry.list('owner', [])).sessions.some(session => session.id === 'codex-native:host:exec')).toBe(true)
})
