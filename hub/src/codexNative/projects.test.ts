import { describe, expect, test } from 'bun:test'
import { desktopNativeProjects, projectMemberships } from './projects'
import { NativeService } from './service'
import { desktopProjects, type WorkspaceIdentity } from './desktopSelection'
import type { NativeConnection, NativeRecord } from './transport'

function desktopFixture(state: NativeRecord, canonical: NativeRecord[]) {
    const calls: string[] = []
    let available = true
    const service = new NativeService({ endpoint: 'unix:///fixture.sock', namespace: 'owner', desktopHostId: 'wsl', desktopStatePath: '/fixture/state.json' })
    service.desktop = async () => available ? { state, projects: desktopProjects(state, 'wsl'), membership: 'desktop' }
        : { projects: [], membership: 'fallback' }
    service.call = async method => {
        calls.push(method)
        if (method !== 'project/list') throw Error(`Unexpected lookup operation ${method}`)
        return { data: canonical }
    }
    const identities = new Map<string, WorkspaceIdentity>()
    Object.assign(service, { identities: async (path: string) => identities.get(path) ?? { path } })
    return { service, calls, identities, unavailable: () => { available = false }, setCanonical: (values: NativeRecord[]) => { canonical = values } }
}
const ordinary = (id: string, cwd: string): NativeRecord => ({ id, cwd, projectId: null, source: 'vscode', threadSource: 'user' })

describe('Native workspace membership', () => {
    test('links only host identity, canonical migration metadata, or one exact root; names never resolve ambiguity', () => {
        const linked = desktopNativeProjects({ 'app-server-project-id-by-legacy-project-id-by-host': {
            'wsl:one': { official: 'host-target', conflict: 'duplicate-a' },
            'wsl:two': { conflict: 'duplicate-b' },
            'foreign:one': { nameOnly: 'host-target' },
        } }, 'wsl', [
            { id: 'official', name: 'Same', path: '/wrong' }, { id: 'metadata', name: 'Other', path: '/wrong' },
            { id: 'root', name: 'Unrelated name', path: '/exact/' }, { id: 'nameOnly', name: 'Canonical', path: '/unmatched' },
            { id: 'ambiguous', name: 'Same', path: '/duplicate' }, { id: 'conflict', name: 'Same', path: '/duplicate' },
        ], [
            { id: 'host-target', name: 'Canonical', roots: [] },
            { id: 'metadata-target', name: 'Canonical', roots: [], legacyProjectId: 'metadata' },
            { id: 'root-target', name: 'Canonical', roots: [{ path: '/exact' }] },
            { id: 'duplicate-a', name: 'Same', roots: [{ path: '/duplicate' }] },
            { id: 'duplicate-b', name: 'Same', roots: [{ path: '/duplicate' }] },
        ])
        expect([...linked].map(([legacy, project]) => [legacy, project.id])).toEqual([
            ['official', 'host-target'], ['metadata', 'metadata-target'], ['root', 'root-target'],
        ])
    })
    test('three legacy Qt identities and a canonical thread converge without changing raw membership, and rename invalidates the shared cache', async () => {
        const state: NativeRecord = { 'remote-projects': [1, 2, 3].map(i => ({ id: `qt-${i}`, hostId: 'wsl', remotePath: '/repo/Qt', label: `Qt old ${i}` })),
            'app-server-project-id-by-legacy-project-id-by-host': { 'wsl:official': { 'qt-1': 'qt-native' } },
            'thread-project-assignments': Object.fromEntries([1, 2, 3].map(i => [`old-${i}`, { projectKind: 'remote', hostId: 'wsl', projectId: `qt-${i}` }])) }
        const raw = { id: 'qt-native', name: 'Qt', roots: [{ path: '/repo/Qt' }], metadata: { 'codex.localProjectId': 'qt-2' } }
        const { service, calls, setCanonical } = desktopFixture(state, [raw, { id: 'other', name: 'Other', roots: [{ path: '/other' }] }])
        const threads = [1, 2, 3].map(i => ordinary(`old-${i}`, '/repo/Qt'))
        threads.push({ ...ordinary('canonical', '/repo/Qt'), projectId: 'qt-native' })
        const result = await service.withDesktopWorkspaces(threads)
        expect(result.map(thread => (thread.desktopProject as any).nativeId)).toEqual(Array(4).fill('qt-native'))
        expect(result.map(thread => (thread.desktopProject as any).name)).toEqual(Array(4).fill('Qt'))
        expect(result.slice(0, 3).map(thread => (thread.desktopProject as any).id)).toEqual(['qt-1', 'qt-2', 'qt-3'])
        expect(result.map(thread => thread.projectId)).toEqual([null, null, null, 'qt-native'])
        await service.withDesktopWorkspaces(threads.slice(0, 1))
        expect(calls).toEqual(['project/list'])
        const authoritative = await service.withDesktopWorkspaces([{ ...ordinary('old-1', '/repo/Qt'), projectId: 'other' }])
        expect(authoritative[0].desktopProject).toMatchObject({ id: 'other', nativeId: 'other', name: 'Other' })
        expect(authoritative[0].projectId).toBe('other')
        setCanonical([{ ...raw, name: 'Qt renamed' }]); service.invalidateDesktopWorkspaces()
        expect(((await service.withDesktopWorkspaces(threads))[0].desktopProject as any).name).toBe('Qt renamed')
        expect(calls).toEqual(['project/list', 'project/list'])
        const priority = await service.withDesktopWorkspaces([{ ...ordinary('old-1', '/repo/Qt'), projectId: 'absent-canonical' }])
        expect(priority[0].projectId).toBe('absent-canonical')
        expect(priority[0].desktopProject).toBeNull()
    })
    test('reuses Git worktree identity, leaves display-only projects unmapped, and does not claim validation descendants', async () => {
        const state = { 'remote-projects': [{ id: 'legacy', hostId: 'wsl', remotePath: '/repo/Qt', label: 'Qt display only' }] }
        const { service, identities } = desktopFixture(state, [])
        identities.set('/repo/Qt', { path: '/repo/Qt', git: { root: '/repo', commonDir: '/repo/.git', originUrl: 'same-repo' } })
        identities.set('/tmp/.codex/worktrees/run/Qt', { path: '/tmp/.codex/worktrees/run/Qt', git: { root: '/tmp/.codex/worktrees/run', commonDir: '/repo/.git', originUrl: 'same-repo' } })
        const result = await service.withDesktopWorkspaces([ordinary('worktree', '/tmp/.codex/worktrees/run/Qt'), ordinary('validation', '/repo/Qt/validation')])
        expect(result[0].desktopProject).toMatchObject({ id: 'legacy', name: 'Qt display only', path: '/repo/Qt' })
        expect((result[0].desktopProject as any).nativeId).toBeUndefined()
        expect(result[1].desktopProject).toBeNull()
    })
    test('projectless/HAPI empty/background rows are never inferred and require no project catalog', async () => {
        const { service, calls } = desktopFixture({ 'remote-projects': [{ id: 'legacy', hostId: 'wsl', remotePath: '/repo', label: 'Workspace' }], 'projectless-thread-ids': ['desktop-projectless'] }, [])
        const threads = [
            { ...ordinary('hapi', '/repo'), originator: 'hapi-native' },
            { ...ordinary('cleared', '/repo'), desktopProjectCleared: true },
            { ...ordinary('runtime-projectless', '/repo'), workspaceKind: 'projectless' }, ordinary('desktop-projectless', '/repo'),
            { ...ordinary('child', '/repo'), parentThreadId: 'root' }, { ...ordinary('ephemeral', '/repo'), ephemeral: true },
            { ...ordinary('exec', '/repo'), originator: 'codex_exec' },
            { ...ordinary('subagent', '/repo'), source: { subAgent: { thread_spawn: {} } } },
        ]
        expect((await service.withDesktopWorkspaces(threads)).map(thread => thread.desktopProject)).toEqual(threads.map(() => null))
        expect(calls).toEqual([])
    })
    test('unreadable or unconfigured Desktop preserves existing information without new daemon reads', async () => {
        const { service, calls, unavailable } = desktopFixture({ 'remote-projects': [] }, [])
        const rows = [{ ...ordinary('known', '/repo'), desktopProject: { id: 'legacy', name: 'Keep', path: '/repo' } }]
        unavailable()
        expect(await service.withDesktopWorkspaces(rows)).toBe(rows)
        expect(calls).toEqual([])
        const unconfigured = new NativeService({ endpoint: 'ws://unused' })
        unconfigured.desktop = async () => { throw Error('Unconfigured Desktop must not be read') }
        unconfigured.call = async () => { throw Error('Unconfigured daemon must not be read') }
        expect(await unconfigured.withDesktopWorkspaces(rows)).toBe(rows)
    })
    test('does not expand Git command execution to other remote endpoints', async () => {
        const { service, calls } = desktopFixture({ 'remote-projects': [{ id: 'legacy', hostId: 'wsl', remotePath: '/repo', label: 'Workspace' }] }, [])
        service.config.endpoint = 'ws://remote-machine'
        const rows = await service.withDesktopWorkspaces([ordinary('worktree', '/tmp/.codex/worktrees/unknown')])
        expect(rows[0].desktopProject).toBeNull()
        expect(calls).toEqual(['project/list'])
    })
    test('shares an in-flight metadata read across batches and invalidation prevents stale refill', async () => {
        const { service, calls } = desktopFixture({ 'remote-projects': [{ id: 'legacy', hostId: 'wsl', remotePath: '/repo', label: 'Display' }] }, [])
        let release!: (value: unknown) => void, began!: () => void
        const started = new Promise<void>(resolve => { began = resolve })
        const response = new Promise(resolve => { release = resolve })
        service.call = async method => {
            calls.push(method)
            if (calls.length === 1) { began(); return response }
            return { data: [{ id: 'canonical', name: 'New name', roots: [{ path: '/repo' }] }] }
        }
        const rows = [ordinary('old', '/repo')]
        const first = service.withDesktopWorkspaces(rows), second = service.withDesktopWorkspaces(rows)
        await started
        expect(calls).toEqual(['project/list'])
        service.invalidateDesktopWorkspaces()
        expect((await service.withDesktopWorkspaces(rows))[0].desktopProject).toMatchObject({ nativeId: 'canonical', name: 'New name' })
        release({ data: [{ id: 'canonical', name: 'Stale name', roots: [{ path: '/repo' }] }] })
        expect(await first).toBe(rows); expect(await second).toBe(rows)
        expect((await service.withDesktopWorkspaces(rows))[0].desktopProject).toMatchObject({ nativeId: 'canonical', name: 'New name' })
        expect(calls).toEqual(['project/list', 'project/list'])
    })
    test('maps observed Desktop migration IDs while preserving canonical-only projects', () => {
        const result = projectMemberships([
            { id: 'daemon', name: 'Canonical', roots: [{ path: '/repo' }] },
            { id: 'new', name: 'New', roots: [{ path: '/other' }] },
        ], { state: { 'app-server-project-id-by-legacy-project-id-by-host': { 'remote:home': { legacy: 'daemon' } } }, projects: [{ id: 'legacy', name: 'Desktop', path: '/repo' }] }, 'remote')
        expect(result.get('daemon')?.id).toBe('legacy')
        expect(result.get('new')).toMatchObject({ id: 'new', path: '/other' })
    })
    test('keeps creating project and projectless HAPI threads in the catalog with Desktop state', async () => {
        let id = 0
        const service = new NativeService({ endpoint: 'ws://target', desktopHostId: 'local' }, () => ({
            listeners: new Set(), close() {}, async request(method: string, params: any) {
                if (method === 'thread/start') return { thread: { id: `created-${++id}`, cwd: '/repo', source: 'vscode', originator: 'hapi-native', threadSource: 'user', ...params } }
                throw new Error('No durable rollout')
            },
        }) as unknown as NativeConnection)
        service.call = async method => method === 'project/list' ? { data: [{ id: 'canonical', name: 'New', roots: [{ path: '/repo' }] }] } : { data: [] }
        service.desktop = async () => ({ state: { 'local-projects': { legacy: { id: 'legacy', name: 'Existing Desktop workspace', rootPaths: ['/repo'] } } }, projects: [{ id: 'legacy', name: 'Existing Desktop workspace', path: '/repo' }], membership: 'desktop' })
        await service.startThread({ cwd: '/repo', projectId: 'canonical', threadSource: 'user' })
        await service.startThread({ cwd: '/repo', projectId: null, threadSource: 'user' })
        const page = await service.catalog({ limit: 100 })
        expect((page.data as any[]).map(thread => [thread.id, thread.desktopProjectId])).toEqual([['created-2', null], ['created-1', 'canonical']])
        service.dispose()
    })
    test('canonical project fallback cannot revive explicit Desktop exclusions, including deleted HAPI chats', async () => {
        const service = new NativeService({ endpoint: 'ws://target', desktopHostId: 'local' })
        service.desktop = async () => ({ state: {
            'local-projects': {},
            'electron-persisted-atom-state': { 'codex-writing-block-deleted-thread-v1:deleted': true, 'codex-writing-block-deleted-thread-v1:hapi-deleted': true },
            'projectless-thread-ids': ['explicit-projectless', 'hapi-explicit-projectless'],
            'thread-project-assignments': { chatgpt: { projectKind: 'local', projectOrigin: 'chatgpt', projectId: 'web-project' } },
        }, projects: [], membership: 'desktop' })
        service.call = async method => method === 'project/list' ? { data: [{ id: 'canonical', name: 'Workspace', roots: [{ path: '/repo' }] }] } : { data: [
            ...['deleted', 'explicit-projectless', 'chatgpt', 'kept'].map(id => ({ id, cwd: '/repo', projectId: 'canonical', source: 'vscode', threadSource: 'user' })),
            { id: 'runtime-projectless', cwd: '/repo', projectId: 'canonical', source: 'vscode', workspaceKind: 'projectless' },
            { id: 'hapi-deleted', cwd: '/repo', projectId: 'canonical', source: 'vscode', originator: 'hapi-native', threadSource: 'user' },
            { id: 'hapi-runtime-projectless', cwd: '/repo', projectId: null, source: 'vscode', originator: 'hapi-native', threadSource: 'user', workspaceKind: 'projectless' },
            { id: 'hapi-explicit-projectless', cwd: '/repo', projectId: null, source: 'vscode', originator: 'hapi-native', threadSource: 'user' },
        ] }
        const data = (await service.catalog({ limit: 100 })).data as any[]
        expect(data.map(thread => thread.id)).toEqual(['kept', 'hapi-runtime-projectless', 'hapi-explicit-projectless'])
        expect(data.filter(thread => thread.id.startsWith('hapi-')).map(thread => thread.desktopProject)).toEqual([null, null])
    })
})
