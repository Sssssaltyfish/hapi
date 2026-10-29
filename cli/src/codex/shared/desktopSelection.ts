import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { record, string } from './gateway';

export type DesktopProject = { id: string; name: string; path: string };
export type GitOrigin = { root: string; commonDir: string; originUrl?: string };
export type WorkspaceIdentity = { path: string; git?: GitOrigin };
const execute = promisify(execFile);
const normalize = (path: string) => posix.normalize(path.replaceAll('\\', '/')).replace(/\/$/, '') || '/';
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

export function desktopProjects(value: unknown, hostId: string): DesktopProject[] {
    const state = record(value);
    if (!Array.isArray(state['remote-projects'])) throw new Error('Unsupported desktop project state; discovery is suspended');
    return state['remote-projects'].flatMap(value => {
        const p = record(value);
        if (p.hostId !== hostId) return [];
        const id = string(p.id), path = string(p.remotePath), name = string(p.label);
        if (!id || !path || !name) throw new Error('Invalid desktop project');
        return [{ id, path, name }];
    });
}

/** agent_created_thread is not an exclusion: these can be ordinary sidebar chats. */
export function isDesktopThread(thread: Record<string, unknown>): boolean {
    return thread.ephemeral !== true && thread.archived !== true && !thread.parentThreadId && !thread.parent_thread_id
        && thread.threadSource !== 'ambient_suggestions'
        && (thread.source === 'cli' || thread.source === 'vscode');
}

/** Remote sidebar grouping: assignment, exact/canonical cwd, then Git worktree identity.
 * A project directory never claims arbitrary validation-run descendants.
 */
export function desktopThreadSelection(value: unknown, hostId: string, threads: Record<string, unknown>[],
    identities: Map<string, WorkspaceIdentity> = new Map()): Map<string, DesktopProject> {
    const state = record(value), projects = desktopProjects(state, hostId);
    const assignments = record(state['thread-project-assignments']);
    const atoms = record(state['electron-persisted-atom-state']);
    const hints = record(state['thread-workspace-root-hints']);
    const projectless = new Set(Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : []);
    const identity = (path: string): WorkspaceIdentity => identities.get(path) ?? { path: normalize(path) };
    const result = new Map<string, DesktopProject>();
    for (const thread of threads) {
        const id = string(thread.id), cwd = string(thread.cwd);
        if (!id || !cwd || !isDesktopThread(thread) || atoms[`codex-writing-block-deleted-thread-v1:${id}`] === true) continue;
        const assignment = record(assignments[id]);
        const assigned = assignment.projectKind === 'remote' && assignment.hostId === hostId
            ? projects.find(project => project.id === assignment.projectId) : undefined;
        if (assigned) { result.set(id, assigned); continue; }
        if (assignment.projectKind === 'local' && assignment.projectOrigin === 'chatgpt') continue;
        if (thread.workspaceKind === 'projectless' || projectless.has(id)) continue;
        const current = identity(cwd);
        const exact = projects.find(project => normalize(project.path) === normalize(cwd))
            ?? projects.find(project => identity(project.path).path === current.path);
        if (exact) { result.set(id, exact); continue; }
        const git = current.git;
        const linked = git && normalize(git.commonDir) !== `${normalize(git.root)}/.git`;
        const managed = normalize(cwd).includes('/.codex/worktrees/');
        if (!linked && !managed) continue;
        const candidates = projects.flatMap(project => {
            const target = identity(project.path);
            if (!git || !target.git || !within(current.path, git.root) || !within(target.path, target.git.root)) return [];
            const sameRepo = git.originUrl ? git.originUrl === target.git.originUrl : git.commonDir === target.git.commonDir;
            if (!sameRepo) return [];
            return [{ project, relative: posix.relative(target.git.root, target.path) }];
        });
        const relative = git ? posix.relative(git.root, current.path) : '';
        const matching = candidates.filter(candidate => candidate.relative === relative);
        const hinted = candidates.find(candidate => normalize(candidate.project.path) === hints[id]);
        const roots = candidates.filter(candidate => candidate.relative === '');
        // Ambiguous clones require the desktop's root hint, never a hard-coded thread list.
        const resolved = matching.length === 1 ? matching[0] : hinted ?? (roots.length === 1 ? roots[0] : undefined);
        if (resolved) result.set(id, resolved.project);
        else if (!git && typeof hints[id] === 'string') {
            const hint = projects.find(project => normalize(project.path) === normalize(hints[id] as string));
            if (hint) result.set(id, hint);
        }
    }
    return result;
}

export function createWorkspaceIdentityReader() {
    const cache = new Map<string, { expires: number; value: WorkspaceIdentity }>();
    return async (path: string): Promise<WorkspaceIdentity> => {
        const cached = cache.get(path);
        if (cached && cached.expires > Date.now()) return cached.value;
        const value: WorkspaceIdentity = { path: normalize(path) };
        try { value.path = normalize(await realpath(path)); } catch { /* Missing cwd may have explicit membership. */ }
        const git = async (args: string[]) => (await execute('git', ['-C', path, ...args], { timeout: 3000, maxBuffer: 16_384 })).stdout.trim();
        try {
            const [root, commonDir] = (await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])).split('\n');
            if (root && commonDir) {
                value.git = { root: normalize(await realpath(root)), commonDir: normalize(await realpath(commonDir)) };
                try { value.git.originUrl = await git(['config', '--get', 'remote.origin.url']) || undefined; } catch { /* Local repositories are valid. */ }
            }
        } catch { /* Non-Git projects use exact cwd membership. */ }
        if (cache.size >= 512) cache.delete(cache.keys().next().value!);
        cache.set(path, { value, expires: Date.now() + (value.git ? 60_000 : 10_000) });
        return value;
    };
}
