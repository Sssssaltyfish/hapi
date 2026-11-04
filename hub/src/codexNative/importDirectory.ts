import type { SessionSummary } from '@hapi/protocol'
import type { DaemonProject, NativeProjectPageOptions } from './projects'
import type { NativeRecord } from './transport'

type Page<T> = { data: T[]; nextCursor: string | null }
type ReadPage<T> = (options: NativeProjectPageOptions) => Promise<Page<T>>
type ImportProject = DaemonProject & { desktopProjectId?: string }
type ImportCursor = { key: string; phase: 'cached' | 'daemon'; after?: string; cursor?: string }
const cursorPrefix = 'hapi-import-v1:'
export class NativeImportCursorError extends Error {}

function encodeCursor(value: ImportCursor): string {
    return cursorPrefix + Buffer.from(JSON.stringify(value)).toString('base64url')
}
function decodeCursor(cursor: string | undefined, key: string): ImportCursor {
    if (!cursor) return { key, phase: 'cached' }
    // Already-open trees can retain a raw daemon continuation across an update.
    if (!cursor.startsWith(cursorPrefix)) return { key, phase: 'daemon', cursor }
    try {
        const value = JSON.parse(Buffer.from(cursor.slice(cursorPrefix.length), 'base64url').toString())
        if (value?.key === key && ['cached', 'daemon'].includes(value.phase)
            && (value.after === undefined || typeof value.after === 'string')
            && (value.cursor === undefined || typeof value.cursor === 'string')) return value
    } catch { /* Report malformed or wrong-bucket continuations consistently. */ }
    throw new NativeImportCursorError('Invalid native import page')
}

/** At most one daemon page, with cached members counted against the same response limit. */
async function importPage<T>(cached: T[], options: NativeProjectPageOptions, key: string, identity: (item: T) => string, read?: ReadPage<T>): Promise<Page<T>> {
    const state = decodeCursor(options.cursor, key)
    const known = new Set(cached.map(identity))
    let data: T[] = []
    if (state.phase === 'cached') {
        const remaining = cached.filter(item => !state.after || identity(item) > state.after)
            .sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0)
        data = remaining.slice(0, options.limit)
        if (remaining.length > data.length) return { data, nextCursor: encodeCursor({ key, phase: 'cached', after: identity(data.at(-1)!) }) }
        if (read && data.length === options.limit) return { data, nextCursor: encodeCursor({ key, phase: 'daemon' }) }
    } else if (!read) throw new NativeImportCursorError('Invalid native import page')
    if (!read) return { data, nextCursor: null }
    const page = await read({ cursor: state.cursor, limit: options.limit - data.length })
    return {
        data: [...data, ...page.data.filter(item => !known.has(identity(item)))],
        nextCursor: page.nextCursor ? encodeCursor({ key, phase: 'daemon', cursor: page.nextCursor }) : null,
    }
}

export function nativeImportProjectsPage(sessions: SessionSummary[], options: NativeProjectPageOptions, read: ReadPage<DaemonProject>) {
    const identity = (project: ImportProject) => `${project.desktopProjectId ? 'desktop' : 'daemon'}:${project.id}`
    const known = new Map<string, ImportProject>()
    for (const session of sessions) {
        const native = session.metadata?.nativeCodex
        const id = native?.projectId ?? native?.desktopProjectId
        if (!id) continue
        const project = { id, name: native?.projectName ?? id, roots: native?.projectPath ? [{ path: native.projectPath }] : [], ...(!native?.projectId ? { desktopProjectId: id } : {}) }
        known.set(identity(project), project)
    }
    return importPage([...known.values()], options, 'projects', identity, read)
}

export function nativeImportMembersPage(sessions: SessionSummary[], projectId: string | null, desktopProjectId: string | undefined, options: NativeProjectPageOptions, read?: ReadPage<NativeRecord>) {
    const known = new Set<string>()
    const members = sessions.flatMap(session => {
        const native = session.metadata?.nativeCodex
        if (!native) return []
        known.add(native.threadId)
        const belongs = desktopProjectId ? native.desktopProjectId === desktopProjectId
            : projectId ? native.projectId === projectId : !native.projectId && !native.desktopProjectId
        return belongs ? [{ id: native.threadId, name: session.metadata?.name, cwd: session.metadata?.path,
            projectId: native.projectId ?? null, desktopProjectId: native.desktopProjectId,
            createdAt: session.createdAt, updatedAt: session.updatedAt }] : []
    })
    const key = desktopProjectId ? `desktop:${desktopProjectId}` : projectId ? `project:${projectId}` : 'projectless'
    return importPage<NativeRecord>(members, options, key, item => String(item.id), read ? async options => {
        const page = await read(options)
        return { ...page, data: page.data.filter(thread => !known.has(String(thread.id))) }
    } : undefined)
}
