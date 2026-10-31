import { describe, expect, test } from 'bun:test'
import { projectMemberships } from './projects'
import { NativeService } from './service'
import type { NativeConnection } from './transport'

describe('Native workspace membership', () => {
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
