import { describe, expect, test } from 'bun:test'
import { assignDaemonProject, daemonProjectsPage, daemonProjectThreadsPage, renameDaemonProject } from './projects'
import type { NativeService } from './service'

describe('Native project operations', () => {
    test('reads one authoritative page and filters members on the daemon before pagination', async () => {
        const calls: Array<{ method: string; params: unknown }> = []
        const service = { call: async (method: string, params: unknown) => {
            calls.push({ method, params })
            return method === 'project/list'
                ? { data: [{ id: 'p', name: 'Project', roots: [{ path: '/repo' }], metadata: { 'codex.localProjectId': 'legacy' } }], nextCursor: 'projects-next' }
                : { data: [{ id: 'child', projectId: 'p', source: 'subAgent', parentThreadId: 'parent' }, { id: 'human', projectId: 'p', source: 'appServer', threadSource: 'user' }], nextCursor: 'members-next' }
        } } as unknown as NativeService
        expect(await daemonProjectsPage(service, { cursor: 'projects-prev', limit: 1 })).toMatchObject({ data: [{ id: 'p', legacyProjectId: 'legacy' }], nextCursor: 'projects-next' })
        expect(await daemonProjectThreadsPage(service, 'p', { cursor: 'members-prev', limit: 7 })).toMatchObject({ data: [{ id: 'human', source: 'appServer', threadSource: 'user' }], nextCursor: 'members-next' })
        await daemonProjectThreadsPage(service, null, { limit: 1 })
        expect(calls).toHaveLength(3)
        expect(calls[1]).toMatchObject({ method: 'thread/list', params: { projectId: 'p', cursor: 'members-prev', limit: 7, useStateDbOnly: true, archived: false } })
        expect((calls[1]!.params as any).sourceKinds).toContain('appServer')
        expect(calls[2]).toMatchObject({ method: 'thread/list', params: { projectId: null, limit: 1 } })
    })
    test('moves only project metadata, clears with empty string, and renames without replacing roots', async () => {
        const calls: Array<{ method: string; params: any }> = []
        const service = { call: async (method: string, params: any) => {
            calls.push({ method, params })
            return method === 'thread/metadata/update'
                ? { thread: { id: params.threadId, projectId: params.projectId || null, cwd: '/unchanged' } }
                : { project: { id: params.projectId, name: params.name, roots: [{ path: '/unchanged' }] } }
        } } as unknown as NativeService
        await assignDaemonProject(service, 't', 'p')
        await assignDaemonProject(service, 't', null)
        await renameDaemonProject(service, 'p', 'New name')
        expect(calls).toEqual([
            { method: 'thread/metadata/update', params: { threadId: 't', projectId: 'p' } },
            { method: 'thread/metadata/update', params: { threadId: 't', projectId: '' } },
            { method: 'project/update', params: { projectId: 'p', name: 'New name' } },
        ])
    })
    test('rejects unconfirmed acknowledgments and nonadvancing cursors without retrying writes', async () => {
        let calls = 0
        const service = { call: async () => { calls++; return { thread: { id: 't', projectId: 'old' }, data: [], nextCursor: 'same' } } } as unknown as NativeService
        await expect(assignDaemonProject(service, 't', 'new')).rejects.toThrow('not confirmed')
        await expect(daemonProjectsPage(service, { limit: 1, cursor: 'same' })).rejects.toThrow('did not advance')
        expect(calls).toBe(2)
    })
})
