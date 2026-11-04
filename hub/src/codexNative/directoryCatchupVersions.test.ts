import { describe, expect, test } from 'bun:test'
import { NativeRegistry } from './registry'
import type { NativeService } from './service'

function fixture() {
    const config = { id: 'machine', namespace: 'owner', label: 'Native', endpoint: 'ws://unused' }
    const service = {
        authorized: (namespace: string) => namespace === 'owner', dispose() {},
        call: async (method: string, params: any) => {
            if (method === 'project/read') return { project: { id: params.projectId, name: 'Original workspace', roots: [] } }
            throw Error(`Unexpected directory RPC ${method}`)
        },
    } as unknown as NativeService
    return new NativeRegistry([config], () => service)
}

describe('Directory reconciliation event epochs', () => {
    test('a same-value native name event invalidates an older in-flight intermediate read', async () => {
        const registry = fixture()
        await registry.trackCreated('owner', 'machine', { id: 't', name: 'Original', source: 'cli', cwd: '/fixture', projectId: null })
        const captured = await registry.trackedDirectorySnapshot('owner', 'machine')
        // The RPC captured an intermediate value, then Desktop reverted it to the
        // value already in HAPI's cache before that old RPC completed.
        await registry.observeCatalogEvent('owner', 'machine', { method: 'thread/name/updated', params: { threadId: 't', threadName: 'Original' } })
        await registry.applyDirectoryReconciliation('owner', 'machine', { threads: [{ id: 't', name: 'Intermediate' }] }, captured.versions)
        expect((await registry.list('owner', [])).sessions[0]?.metadata?.name).toBe('Original')
    })
    test('a same-value native project event also invalidates an older project read', async () => {
        const registry = fixture()
        await registry.trackCreated('owner', 'machine', { id: 't', name: 'Chat', source: 'cli', cwd: '/fixture', projectId: 'p' })
        await registry.observeProject('owner', 'machine', { id: 'p', name: 'Original workspace', roots: [] })
        const captured = await registry.trackedDirectorySnapshot('owner', 'machine')
        await registry.observeCatalogEvent('owner', 'machine', { method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } })
        await registry.applyDirectoryReconciliation('owner', 'machine', { projects: [{ id: 'p', name: 'Intermediate workspace', roots: [] }] }, captured.versions)
        expect((await registry.list('owner', [])).sessions[0]?.metadata?.nativeCodex?.projectName).toBe('Original workspace')
    })
    test('an unrelated busy chat does not invalidate another tracked chat refresh', async () => {
        const registry = fixture()
        for (const id of ['a', 'b']) await registry.trackCreated('owner', 'machine', { id, name: 'Old', source: 'cli', cwd: '/fixture', projectId: null })
        const captured = await registry.trackedDirectorySnapshot('owner', 'machine')
        await registry.observeCatalogEvent('owner', 'machine', { method: 'thread/name/updated', params: { threadId: 'b', threadName: 'Old' } })
        await registry.applyDirectoryReconciliation('owner', 'machine', { threads: [{ id: 'a', name: 'Refreshed' }] }, captured.versions)
        expect((await registry.list('owner', [])).sessions.find(session => session.id.endsWith(':a'))?.metadata?.name).toBe('Refreshed')
    })
    test('a snapshot captured during an in-flight native event cannot overwrite its eventual same-value result', async () => {
        const registry = fixture()
        await registry.trackCreated('owner', 'machine', { id: 't', name: 'Chat', source: 'cli', cwd: '/fixture', projectId: 'p' })
        await registry.observeProject('owner', 'machine', { id: 'p', name: 'Original workspace', roots: [] })
        let started: (() => void) | undefined, finish: (() => void) | undefined
        const entered = new Promise<void>(resolve => { started = resolve })
        const pending = new Promise<void>(resolve => { finish = resolve })
        registry.get('owner', 'machine')!.service.call = async () => {
            started!()
            await pending
            return { project: { id: 'p', name: 'Original workspace', roots: [] } }
        }
        const event = registry.observeCatalogEvent('owner', 'machine', { method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } })
        await entered
        const captured = await registry.trackedDirectorySnapshot('owner', 'machine')
        expect(captured.versions['event:project:p']).toBe(-1)
        finish!(); await event
        await registry.applyDirectoryReconciliation('owner', 'machine', { projects: [{ id: 'p', name: 'Intermediate workspace', roots: [] }] }, captured.versions)
        expect((await registry.list('owner', [])).sessions[0]?.metadata?.nativeCodex?.projectName).toBe('Original workspace')
    })
})
