import { record, text, type NativeRecord } from './transport'
import type { NativeService } from './service'
import { normalizeWorkspacePath, type DesktopProject } from './desktopSelection'
import { isNativeBackgroundThread, NATIVE_ORDINARY_SOURCE_KINDS, NATIVE_BACKGROUND_SOURCE_KINDS } from '@hapi/protocol/codexNativeVisibility'

export type DaemonProject = { id: string; name: string; roots: Array<{ path: string }>; legacyProjectId?: string }

/** Resolve identities, never names. Ambiguous authoritative mappings do not fall through. */
export function desktopNativeProjects(state: NativeRecord, hostId: string, desktop: DesktopProject[], canonical: DaemonProject[]): Map<string, DaemonProject> {
    const mappings = Object.entries(record(state['app-server-project-id-by-legacy-project-id-by-host']))
        .filter(([key]) => key.startsWith(`${hostId}:`)).map(([, value]) => record(value))
    const result = new Map<string, DaemonProject>()
    for (const project of desktop) {
        const mappedIds = [...new Set(mappings.flatMap(mapping => text(mapping[project.id]) ?? []))]
        if (mappedIds.length > 1) continue
        const byHost = canonical.filter(value => mappedIds.includes(value.id))
        const byMetadata = canonical.filter(value => value.id === project.id || value.legacyProjectId === project.id)
        const roots = new Set((project.rootPaths ?? [project.path]).map(normalizeWorkspacePath))
        const byRoot = canonical.filter(value => value.roots.some(root => roots.has(normalizeWorkspacePath(root.path))))
        const candidates = byHost.length ? byHost : byMetadata.length ? byMetadata : byRoot
        if (candidates.length === 1) result.set(project.id, candidates[0])
    }
    return result
}

export function daemonProject(value: unknown): DaemonProject | undefined {
    const project = record(value)
    const id = text(project.id), name = text(project.name)
    const roots = Array.isArray(project.roots) ? project.roots.flatMap(root => {
        const path = text(record(root).path)
        return path ? [{ path }] : []
    }) : []
    const legacyProjectId = text(record(project.metadata)['codex.localProjectId'])
    return id && name ? { id, name, roots, ...(legacyProjectId ? { legacyProjectId } : {}) } : undefined
}

export type NativeProjectPageOptions = { cursor?: string; limit: number }

function nextProjectCursor(page: NativeRecord, cursor?: string): string | null {
    const next = text(page.nextCursor) ?? null
    if (next && next === cursor) throw new Error('Native project pagination did not advance')
    return next
}

/** One native page. Importers decide when to request the next page. */
export async function daemonProjectsPage(service: NativeService, options: NativeProjectPageOptions) {
    const page = record(await service.call('project/list', {
        limit: options.limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
    }))
    return {
        data: (Array.isArray(page.data) ? page.data : []).flatMap(value => {
            const project = daemonProject(value)
            return project ? [project] : []
        }),
        nextCursor: nextProjectCursor(page, options.cursor),
    }
}

/** projectId:null is the protocol's unassigned filter; omitting it means all projects. */
export async function daemonProjectThreadsPage(service: NativeService, projectId: string | null, options: NativeProjectPageOptions) {
    const page = record(await service.call('thread/list', {
        projectId,
        limit: options.limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        archived: false,
        sourceKinds: NATIVE_ORDINARY_SOURCE_KINDS,
        modelProviders: [],
        useStateDbOnly: true,
        sortKey: 'updated_at',
        sortDirection: 'desc',
    }))
    return {
        data: (Array.isArray(page.data) ? page.data : []).map(record).filter(thread => text(thread.id) && !isNativeBackgroundThread(thread)),
        nextCursor: nextProjectCursor(page, options.cursor),
    }
}

const backgroundCursorPrefix = 'hapi-bg-v1:'
type BackgroundPage = { phase: 'native' | 'legacy'; cursor: string | null }
export class NativeBackgroundCursorError extends Error {}
function backgroundPage(cursor?: string): BackgroundPage {
    if (!cursor) return { phase: 'native', cursor: null }
    // Older clients may still hold a raw cursor for the original source family.
    if (!cursor.startsWith(backgroundCursorPrefix)) {
        if (cursor.length > 8192) throw new NativeBackgroundCursorError('Invalid native background cursor')
        return { phase: 'native', cursor }
    }
    try {
        const value = record(JSON.parse(Buffer.from(cursor.slice(backgroundCursorPrefix.length), 'base64url').toString('utf8')))
        if ((value.phase !== 'native' && value.phase !== 'legacy') ||
            (value.cursor !== null && (typeof value.cursor !== 'string' || !value.cursor.length || value.cursor.length > 8192))) throw Error('Invalid cursor')
        return { phase: value.phase, cursor: value.cursor as string | null }
    } catch { throw new NativeBackgroundCursorError('Invalid native background cursor') }
}
function backgroundCursor(page: BackgroundPage): string {
    return backgroundCursorPrefix + Buffer.from(JSON.stringify(page)).toString('base64url')
}

/** One host-level page per explicit request, independent of project assignment. */
export async function daemonBackgroundThreadsPage(service: NativeService, options: NativeProjectPageOptions) {
    const current = backgroundPage(options.cursor)
    const page = record(await service.call('thread/list', {
        limit: options.limit, ...(current.cursor ? { cursor: current.cursor } : {}), archived: false,
        sourceKinds: current.phase === 'native' ? NATIVE_BACKGROUND_SOURCE_KINDS : ['cli', 'vscode'], modelProviders: [], useStateDbOnly: true,
        sortKey: 'updated_at', sortDirection: 'desc',
    }))
    const next = nextProjectCursor(page, current.cursor ?? undefined)
    return { data: (Array.isArray(page.data) ? page.data : []).map(record)
        .filter(thread => text(thread.id) && isNativeBackgroundThread(thread)),
        nextCursor: next ? backgroundCursor({ phase: current.phase, cursor: next })
            : current.phase === 'native' ? backgroundCursor({ phase: 'legacy', cursor: null }) : null }
}

export async function assignDaemonProject(service: NativeService, threadId: string, projectId: string | null): Promise<NativeRecord> {
    // null/omitted leaves metadata unchanged. Desktop clears assignment with ''.
    const response = record(await service.call('thread/metadata/update', { threadId, projectId: projectId ?? '' }))
    const thread = record(response.thread)
    if (thread.id !== threadId || !Object.hasOwn(thread, 'projectId') || thread.projectId !== projectId)
        throw new Error('Native workspace assignment was not confirmed; refresh before retrying')
    return thread
}

export async function renameDaemonProject(service: NativeService, projectId: string, name: string): Promise<DaemonProject> {
    // Updating only name preserves roots, metadata, ordering, and thread workspace settings.
    const response = record(await service.call('project/update', { projectId, name }))
    const project = daemonProject(response.project)
    if (!project || project.id !== projectId || project.name !== name)
        throw new Error('Native workspace name was not confirmed; refresh before retrying')
    return project
}

export async function listDaemonProjects(service: NativeService, deadline?: number): Promise<DaemonProject[]> {
    const projects: DaemonProject[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
        const page = record(await service.call('project/list', { limit: 100, ...(cursor ? { cursor } : {}) }, deadline))
        for (const value of Array.isArray(page.data) ? page.data : []) {
            const project = daemonProject(value)
            if (project) projects.push(project)
        }
        cursor = text(page.nextCursor)
        if (cursor && cursors.has(cursor)) throw new Error('Native project pagination did not advance')
        if (cursor) cursors.add(cursor)
        if (projects.length > 10_000) throw new Error('Native project list is too large')
    } while (cursor)
    return projects
}

/** Keep Desktop's visible identities when its installed migration map knows the server ID. */
export function projectMemberships(projects: DaemonProject[], desktop: { state?: NativeRecord; projects: DesktopProject[] }, hostId?: string): Map<string, DesktopProject> {
    const mappings = Object.entries(record(desktop.state?.['app-server-project-id-by-legacy-project-id-by-host']))
        .filter(([key]) => hostId === 'local' ? key.startsWith('local:') : Boolean(hostId && key.startsWith(`${hostId}:`)))
        .map(([, mapping]) => record(mapping))
    return new Map(projects.map(project => {
        const existing = desktop.projects.find(candidate => candidate.id === project.id || candidate.id === project.legacyProjectId || mappings.some(mapping => mapping[candidate.id] === project.id))
        return [project.id, existing ?? { id: project.id, name: project.name, path: project.roots[0]?.path ?? '', rootPaths: project.roots.map(root => root.path) }]
    }))
}
