import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { importNativeSelection, isNativeBackgroundThread } from './nativeImport'

const project = { endpointId: 'windows', kind: 'project' as const, id: 'canonical-project', name: 'Workspace' }
const response = (cursor: string | null, threadIds: string[]) => ({ visibility: { initialized: true, threadIds, hiddenThreadIds: [], projects: [{ id: project.id, name: project.name, memberCount: threadIds.length, nextCursor: cursor, complete: cursor === null }] }, sessions: [] })

describe('explicit native imports', () => {
    it('continues a selected workspace with real cursors and stops before another page when cancelled', async () => {
        const update = vi.fn().mockResolvedValueOnce(response('opaque-next', ['one'])).mockResolvedValueOnce(response(null, ['one', 'two']))
        const progress = vi.fn()
        expect(await importNativeSelection({ updateCodexNativeVisibility: update } as unknown as ApiClient, [project], () => false, progress)).toBe(true)
        expect(update.mock.calls.map(call => call[1])).toEqual([{ action: 'track-project', projectId: project.id }, { action: 'discover-project', projectId: project.id }])
        expect(progress.mock.calls).toEqual([[1], [2]])
        let stopped = false
        update.mockReset().mockResolvedValue(response('opaque-next', ['one']))
        expect(await importNativeSelection({ updateCodexNativeVisibility: update } as unknown as ApiClient, [project], () => stopped, () => { stopped = true })).toBe(false)
        expect(update).toHaveBeenCalledTimes(1)
    })

    it('rejects a stalled workspace continuation instead of claiming completion or looping', async () => {
        const update = vi.fn().mockResolvedValue(response('same-cursor', ['one']))
        await expect(importNativeSelection({ updateCodexNativeVisibility: update } as unknown as ApiClient, [project], () => false, () => {})).rejects.toThrow('Try again')
        expect(update).toHaveBeenCalledTimes(2)
    })

    it('explicitly pages the virtual projectless bucket and tracks each distinct native id', async () => {
        const list = vi.fn().mockResolvedValueOnce({ data: [{ id: 'one' }], nextCursor: 'real-next' }).mockResolvedValueOnce({ data: [{ id: 'one' }, { id: 'two' }], nextCursor: null })
        const update = vi.fn().mockResolvedValue(response(null, ['one', 'two']))
        await importNativeSelection({ listCodexNativeProjectThreads: list, updateCodexNativeVisibility: update } as unknown as ApiClient, [{ endpointId: 'windows', kind: 'projectless', id: '', name: 'No workspace' }], () => false, () => {})
        expect(list.mock.calls.map(call => call[2])).toEqual([undefined, 'real-next'])
        expect(update.mock.calls.map(call => call[1])).toEqual([{ action: 'track-thread', threadId: 'one' }, { action: 'track-thread', threadId: 'two' }])
    })

    it('keeps ordinary app-server threads separate from exec and true subagents', () => {
        expect(isNativeBackgroundThread({ source: 'appServer', threadSource: 'user' })).toBe(false)
        expect(isNativeBackgroundThread({ source: 'exec' })).toBe(true)
        expect(isNativeBackgroundThread({ source: { subAgent: { parentThreadId: 'parent' } } })).toBe(true)
        expect(isNativeBackgroundThread({ source: 'appServer', parentThreadId: 'parent' })).toBe(true)
    })
})
