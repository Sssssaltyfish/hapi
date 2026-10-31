import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { record, text as string } from './transport'

export type DesktopProject = { id: string; name: string; path: string; rootPaths?: string[] }
export type GitOrigin = { root: string; commonDir: string; originUrl?: string }
export type WorkspaceIdentity = { path: string; git?: GitOrigin }
const execute = promisify(execFile)
const normalize = (path: string) => {
    const value = posix.normalize(path.replaceAll('\\', '/')).replace(/\/$/, '') || '/'
    return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value
}
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

export function desktopProjects(value: unknown, hostId: string): DesktopProject[] {
    const state = record(value)
    if (hostId === 'local') {
        if (!state['local-projects'] || typeof state['local-projects'] !== 'object')
            throw new Error('Unsupported desktop local project state; discovery is suspended')
        return Object.values(record(state['local-projects'])).flatMap((value) => {
            const p = record(value), id = string(p.id), name = string(p.name)
            const roots = Array.isArray(p.rootPaths) ? p.rootPaths.filter((p): p is string => typeof p === 'string' && Boolean(p)) : []
            if (!id || !name) throw new Error('Invalid desktop local project')
            return roots.length ? [{ id, name, path: roots[0], rootPaths: roots }] : []
        })
    }
    if (!Array.isArray(state['remote-projects']))
        throw new Error('Unsupported desktop project state; discovery is suspended')
    return state['remote-projects'].flatMap((value) => {
        const p = record(value)
        if (p.hostId !== hostId) return []
        const id = string(p.id),
            path = string(p.remotePath),
            name = string(p.label)
        if (!id || !path || !name) throw new Error('Invalid desktop project')
        return [{ id, path, name }]
    })
}

/** agent_created_thread is not an exclusion: these can be ordinary sidebar chats. */
export function isDesktopThread(thread: Record<string, unknown>): boolean {
    return (
        thread.ephemeral !== true &&
        thread.archived !== true &&
        !thread.parentThreadId &&
        !thread.parent_thread_id &&
        !/exec|subagent/i.test(String(thread.originator ?? '')) &&
        thread.threadSource !== 'ambient_suggestions' &&
        (thread.source === 'cli' || thread.source === 'vscode')
    )
}

export function needsDesktopIdentity(value: unknown, thread: Record<string, unknown>): boolean {
    const state = record(value), id = string(thread.id)
    const assignment = record(record(state['thread-project-assignments'])[id ?? ''])
    return Boolean(id && string(thread.cwd) && isDesktopThread(thread) &&
        record(state['electron-persisted-atom-state'])[`codex-writing-block-deleted-thread-v1:${id}`] !== true &&
        !(assignment.projectKind === 'local' && assignment.projectOrigin === 'chatgpt') &&
        thread.workspaceKind !== 'projectless' &&
        !(Array.isArray(state['projectless-thread-ids']) && state['projectless-thread-ids'].includes(id)))
}

/** Remote sidebar grouping: assignment, exact/canonical cwd, then Git worktree identity.
 * A project directory never claims arbitrary validation-run descendants.
 */
export function desktopThreadSelection(
    value: unknown,
    hostId: string,
    threads: Record<string, unknown>[],
    identities: Map<string, WorkspaceIdentity> = new Map()
): Map<string, DesktopProject> {
    const state = record(value),
        projects = desktopProjects(state, hostId)
    const assignments = record(state['thread-project-assignments'])
    const atoms = record(state['electron-persisted-atom-state'])
    const hints = record(state['thread-workspace-root-hints'])
    const projectless = new Set(
        Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : []
    )
    const identity = (path: string): WorkspaceIdentity =>
        identities.get(path) ?? { path: normalize(path) }
    const result = new Map<string, DesktopProject>()
    for (const thread of threads) {
        const id = string(thread.id),
            cwd = string(thread.cwd)
        if (
            !id ||
            !cwd ||
            !isDesktopThread(thread) ||
            atoms[`codex-writing-block-deleted-thread-v1:${id}`] === true
        )
            continue
        const assignment = record(assignments[id])
        const assigned =
            ((assignment.projectKind === 'remote' && assignment.hostId === hostId) ||
                (hostId === 'local' && assignment.projectKind === 'local' && assignment.projectOrigin !== 'chatgpt'))
                ? projects.find((project) => project.id === assignment.projectId)
                : undefined
        if (assigned) {
            result.set(id, assigned)
            continue
        }
        if (assignment.projectKind === 'local' && assignment.projectOrigin === 'chatgpt') continue
        if (thread.workspaceKind === 'projectless' || projectless.has(id)) continue
        const daemonProjectId = string(thread.projectId)
        const hostMappings = record(state['app-server-project-id-by-legacy-project-id-by-host'])
        const mapping = Object.entries(hostMappings).filter(([key]) =>
            hostId === 'local' ? key.startsWith('local:') : key.startsWith(`${hostId}:`)
        ).map(([, value]) => record(value))
        const daemonProject = daemonProjectId && projects.find((project) =>
            project.id === daemonProjectId || mapping.some((map) => map[project.id] === daemonProjectId)
        )
        if (daemonProject) { result.set(id, daemonProject); continue }
        const current = identity(cwd)
        const projectRoots = projects.flatMap((project) => (project.rootPaths ?? [project.path]).map((path) => ({ ...project, path })))
        const exact =
            projectRoots.find((project) => normalize(project.path) === normalize(cwd)) ??
            projectRoots.find((project) => normalize(identity(project.path).path) === normalize(current.path))
        if (exact) {
            result.set(id, exact)
            continue
        }
        const git = current.git
        const linked = git && normalize(git.commonDir) !== `${normalize(git.root)}/.git`
        const managed = normalize(cwd).includes('/.codex/worktrees/')
        if (!linked && !managed) continue
        const candidates = projectRoots.flatMap((project) => {
            const target = identity(project.path)
            if (
                !git ||
                !target.git ||
                !within(current.path, git.root) ||
                !within(target.path, target.git.root)
            )
                return []
            const sameRepo = git.originUrl
                ? git.originUrl === target.git.originUrl
                : git.commonDir === target.git.commonDir
            if (!sameRepo) return []
            return [{ project, relative: posix.relative(target.git.root, target.path) }]
        })
        const relative = git ? posix.relative(git.root, current.path) : ''
        const matching = candidates.filter((candidate) => candidate.relative === relative)
        const hinted = candidates.find(
            (candidate) => normalize(candidate.project.path) === hints[id]
        )
        const roots = candidates.filter((candidate) => candidate.relative === '')
        // Ambiguous clones require the desktop's root hint, never a hard-coded thread list.
        const resolved =
            matching.length === 1
                ? matching[0]
                : (hinted ?? (roots.length === 1 ? roots[0] : undefined))
        if (resolved) result.set(id, resolved.project)
        else if (!git && typeof hints[id] === 'string') {
            const hint = projects.find(
                (project) => normalize(project.path) === normalize(hints[id] as string)
            )
            if (hint) result.set(id, hint)
        }
    }
    return result
}

export function createWorkspaceIdentityReader(remoteGit?: (path: string, args: string[], timeout: number) => Promise<string>) {
    const cache = new Map<string, { expires: number; value: WorkspaceIdentity }>()
    return async (path: string, deadline?: number): Promise<WorkspaceIdentity> => {
        const remaining = () => {
            const budget = deadline === undefined ? 3000 : deadline - Date.now()
            if (budget <= 0) throw new Error('Native directory operation timed out')
            return Math.min(3000, budget)
        }
        remaining()
        const cached = cache.get(path)
        if (cached && cached.expires > Date.now()) return cached.value
        const value: WorkspaceIdentity = { path: normalize(path) }
        if (!remoteGit) {
            try {
                value.path = normalize(await realpath(path))
            } catch {
                /* Missing cwd may have explicit membership. */
            }
        }
        const git = async (args: string[]) =>
            remoteGit ? (await remoteGit(path, args, remaining())).trim() :
            (
                await execute('git', ['-C', path, ...args], {
                    timeout: remaining(),
                    maxBuffer: 16_384,
                })
            ).stdout.trim()
        try {
            const [root, commonDir] = (
                await git([
                    'rev-parse',
                    '--path-format=absolute',
                    '--show-toplevel',
                    '--git-common-dir',
                ])
            ).split(/\r?\n/)
            if (root && commonDir) {
                value.git = {
                    root: normalize(remoteGit ? root : await realpath(root)),
                    commonDir: normalize(remoteGit ? commonDir : await realpath(commonDir)),
                }
                try {
                    value.git.originUrl =
                        (await git(['config', '--get', 'remote.origin.url'])) || undefined
                } catch {
                    /* Local repositories are valid. */
                }
            }
        } catch {
            /* Non-Git projects use exact cwd membership. */
        }
        remaining()
        if (cache.size >= 512) cache.delete(cache.keys().next().value!)
        cache.set(path, { value, expires: Date.now() + (value.git ? 60_000 : 10_000) })
        return value
    }
}
