import { record, text, type NativeRecord } from './transport'
import type { NativeService } from './service'
import type { DesktopProject } from './desktopSelection'

export type DaemonProject = { id: string; name: string; roots: Array<{ path: string }>; legacyProjectId?: string }

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
