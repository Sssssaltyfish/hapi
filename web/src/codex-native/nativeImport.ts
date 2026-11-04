import type { ApiClient } from '@/api/client'
import type { NativeRecord } from './types'
export { isNativeBackgroundThread } from '@hapi/protocol/codexNativeVisibility'

export type NativeImportSelection = { endpointId: string; kind: 'thread' | 'project' | 'projectless' | 'background'; id: string; name: string }
export const nativeImportSelectionKey = (value: NativeImportSelection) => JSON.stringify([value.endpointId, value.kind, value.id])

export function nativeImportTitle(thread: NativeRecord): string {
    for (const key of ['name', 'threadName', 'title', 'preview', 'id']) if (typeof thread[key] === 'string' && thread[key]) return thread[key] as string
    return ''
}

/** Pagination is performed only after the explicit Import action, and stops between requests. */
export async function importNativeSelection(api: ApiClient, selections: NativeImportSelection[], stopped: () => boolean, progress: (count: number) => void) {
    const known = new Map<string, number>()
    const update = (endpointId: string, result: Awaited<ReturnType<ApiClient['updateCodexNativeVisibility']>>) => {
        known.set(endpointId, result.visibility.threadIds.length)
        progress([...known.values()].reduce((sum, count) => sum + count, 0))
    }
    for (const selection of selections) {
        if (stopped()) break
        if (selection.kind === 'thread') {
            update(selection.endpointId, await api.updateCodexNativeVisibility(selection.endpointId, { action: 'track-thread', threadId: selection.id }))
        } else if (selection.kind === 'project') {
            let result = await api.updateCodexNativeVisibility(selection.endpointId, { action: 'track-project', projectId: selection.id })
            const seen = new Set<string>()
            while (true) {
                const project = result.visibility.projects.find(project => project.id === selection.id)
                if (!project) throw new Error('The workspace is no longer selected. Import it again to continue.')
                update(selection.endpointId, result)
                if (project.complete) break
                if (stopped()) break
                if (!project.nextCursor || seen.has(project.nextCursor)) throw new Error('Import paused before completing this workspace. Try again to continue.')
                seen.add(project.nextCursor)
                result = await api.updateCodexNativeVisibility(selection.endpointId, { action: 'discover-project', projectId: selection.id })
            }
        } else {
            let cursor: string | undefined
            const cursors = new Set<string>(), threads = new Set<string>()
            do {
                if (stopped()) break
                const page = selection.kind === 'background'
                    ? await api.listCodexNativeBackgroundThreads(selection.endpointId, cursor)
                    : await api.listCodexNativeProjectThreads(selection.endpointId, null, cursor)
                for (const thread of page.data) {
                    if (stopped()) break
                    if (typeof thread.id !== 'string' || threads.has(thread.id)) continue
                    threads.add(thread.id)
                    update(selection.endpointId, await api.updateCodexNativeVisibility(selection.endpointId, { action: 'track-thread', threadId: thread.id }))
                }
                if (page.nextCursor && cursors.has(page.nextCursor)) throw new Error('Import paused before completing this selection. Try again to continue.')
                cursor = page.nextCursor ?? undefined
                if (cursor) cursors.add(cursor)
            } while (cursor)
        }
    }
    return !stopped()
}
