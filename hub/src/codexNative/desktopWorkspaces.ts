import { desktopExcludesThread, isDesktopThread, type DesktopProject } from './desktopSelection'
import { desktopNativeProjects, type DaemonProject } from './projects'
import { text, type NativeRecord } from './transport'

export type DesktopWorkspaceState = { state?: NativeRecord; projects: DesktopProject[]; membership: 'desktop' | 'fallback' }
type Dependencies = {
    hostId: string
    desktop: (deadline: number) => Promise<DesktopWorkspaceState>
    projects: (deadline: number) => Promise<DaemonProject[]>
    select: (threads: NativeRecord[], desktop: DesktopWorkspaceState, deadline: number, keys: ReadonlyMap<string, string>) => Promise<Map<string, DesktopProject>>
}

function inferable(thread: NativeRecord, state: NativeRecord): boolean {
    return isDesktopThread(thread) && !desktopExcludesThread(state, thread)
        && thread.desktopProjectCleared !== true
        && !(thread.originator === 'hapi-native' && thread.threadSource === 'user' && !text(thread.projectId))
}

/** Directory metadata only. A service shares one bounded project read across pages. */
export class DesktopWorkspaceLookup {
    private generation = 0
    private cached?: { projects: DaemonProject[]; expires: number }
    private reading?: Promise<{ generation: number; projects: DaemonProject[] }>
    constructor(private readonly dependencies: Dependencies) {}

    invalidate(): void { this.generation++; this.cached = undefined; this.reading = undefined }

    private projects(deadline: number): Promise<{ generation: number; projects: DaemonProject[] }> {
        if (this.cached && this.cached.expires > Date.now()) return Promise.resolve({ generation: this.generation, projects: this.cached.projects })
        if (this.reading) return this.reading
        const generation = this.generation
        const reading = this.dependencies.projects(deadline).then(projects => {
            if (generation === this.generation) this.cached = { projects, expires: Date.now() + 30_000 }
            return { generation, projects }
        }).finally(() => { if (this.reading === reading) this.reading = undefined })
        this.reading = reading
        return reading
    }

    async enrich(threads: NativeRecord[]): Promise<NativeRecord[]> {
        if (!threads.length) return threads
        const deadline = Date.now() + 5000, generation = this.generation
        const desktop = await this.dependencies.desktop(deadline)
        // Losing the Desktop file must not erase a previously confirmed display group.
        if (!desktop.state || desktop.membership !== 'desktop') return threads
        const candidates = threads.filter(thread => inferable(thread, desktop.state!))
        if (!candidates.length && !threads.some(thread => text(thread.projectId)))
            return threads.map(thread => ({ ...thread, desktopProject: null, desktopProjectId: null }))
        try {
            const loaded = await this.projects(deadline)
            if (loaded.generation !== generation || this.generation !== generation) return threads
            const links = desktopNativeProjects(desktop.state, this.dependencies.hostId, desktop.projects, loaded.projects)
            const keys = new Map([...links].map(([id, project]) => [id, `native:${project.id}`]))
            const selected = await this.dependencies.select(candidates, desktop, deadline, keys)
            if (this.generation !== generation || Date.now() >= deadline) return threads
            const canonical = new Map(loaded.projects.map(project => [project.id, project]))
            return threads.map(thread => {
                const nativeId = text(thread.projectId)
                let display: DesktopProject | undefined
                if (nativeId) {
                    const project = canonical.get(nativeId)
                    if (project) {
                        const matched = selected.get(String(thread.id))
                        const aliases = desktop.projects.filter(value => links.get(value.id)?.id === nativeId)
                        const legacy = matched && links.get(matched.id)?.id === nativeId ? matched
                            : aliases.length === 1 ? aliases[0] : undefined
                        display = legacy ? { ...legacy, name: project.name, nativeId }
                            : { id: nativeId, nativeId, name: project.name, path: project.roots[0]?.path ?? '', rootPaths: project.roots.map(root => root.path) }
                    }
                } else if (inferable(thread, desktop.state!)) {
                    const legacy = selected.get(String(thread.id))
                    if (legacy) {
                        const project = links.get(legacy.id)
                        display = { id: legacy.id, name: project?.name ?? legacy.name, path: legacy.path,
                            ...(legacy.rootPaths ? { rootPaths: legacy.rootPaths } : {}),
                            ...(project ? { nativeId: project.id } : {}) }
                    }
                }
                return { ...thread, desktopProject: display ?? null, desktopProjectId: display?.id ?? null }
            })
        } catch {
            // A failed metadata/identity lookup cannot prove that old membership vanished.
            return threads
        }
    }
}
