import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';
import { readSettings } from '@/persistence';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { readRuntimes, runtimeMayBeAlive } from './registry';
import { record, string } from './gateway';
import { desktopThreadSelection, desktopProjects, createWorkspaceIdentityReader, type DesktopProject, type WorkspaceIdentity } from './desktopSelection';

export function eligibleThread(thread: Record<string, unknown>, since: number, workspace: string): boolean {
    const cwd = string(thread.cwd);
    const created = thread.createdAt;
    if (!string(thread.id) || !cwd || typeof created !== 'number' || created < since
        || thread.ephemeral === true || thread.archived === true || thread.parentThreadId || thread.parent_thread_id) return false;
    // Exec includes standalone helper/reviewer runs with no parent marker.
    // Keep these available for explicit import, outside automatic discovery.
    if (thread.source === 'exec') return false;
    // Subagents belong to their parent rather than separate top-level HAPI rows.
    if (typeof thread.source === 'string' && /^sub_?agent/i.test(thread.source)) return false;
    if (typeof thread.source === 'object' && thread.source !== null
        && ('subAgent' in thread.source || 'subagent' in thread.source || 'sub_agent' in thread.source)) return false;
    const path = relative(workspace, cwd);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}

export async function listNewThreads(client: Pick<CodexAppServerClient, 'request'>, since: number, workspace: string) {
    const threads: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
        const page = record(await client.request('thread/list', {
            limit: 100, sortKey: 'created_at', sortDirection: 'desc', archived: false,
            sourceKinds: [], useStateDbOnly: true, ...(cursor ? { cursor } : {})
        }));
        if (!Array.isArray(page.data)) throw new Error('Invalid native thread list');
        for (const item of page.data) {
            const thread = record(item);
            if (typeof thread.createdAt === 'number' && thread.createdAt < since) return threads;
            if (eligibleThread(thread, since, workspace)) threads.push(thread);
        }
        cursor = string(page.nextCursor);
        if (cursor && cursors.has(cursor)) throw new Error('Repeated native thread cursor');
        if (cursor) cursors.add(cursor);
    } while (cursor);
    return threads;
}

export async function listArchivedThreadIds(client: Pick<CodexAppServerClient, 'request'>): Promise<Set<string>> {
    // Loaded threads include archived threads, and thread/read omits archived.
    // Obtain archive membership explicitly before considering the empty-thread fallback.
    const archived = new Set<string>();
    let archiveCursor: string | undefined;
    const archiveCursors = new Set<string>();
    do {
        const page = record(await client.request('thread/list', { archived: true, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], limit: 100,
            sortKey: 'created_at', sortDirection: 'desc', ...(archiveCursor ? { cursor: archiveCursor } : {}) }));
        if (!Array.isArray(page.data)) throw new Error('Invalid archived thread list');
        for (const item of page.data) { const id = string(record(item).id); if (id) archived.add(id); }
        archiveCursor = string(page.nextCursor);
        if (archiveCursor && archiveCursors.has(archiveCursor)) throw new Error('Repeated archive cursor');
        if (archiveCursor) archiveCursors.add(archiveCursor);
    } while (archiveCursor);
    return archived;
}

export async function listLoadedNewThreads(client: Pick<CodexAppServerClient, 'request'>, since: number, workspace: string,
    archivedIds?: Set<string>) {
    const archived = archivedIds ?? await listArchivedThreadIds(client);
    const threads: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
        const page = record(await client.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(page.data)) throw new Error('Invalid loaded thread list');
        for (const id of page.data) {
            if (typeof id !== 'string' || archived.has(id)) continue;
            try {
                const thread = record(record(await client.request('thread/read', { threadId: id, includeTurns: false })).thread);
                if (eligibleThread(thread, since, workspace)) threads.push(thread);
            } catch (error) { console.error(`Loaded thread disappeared: ${id}`, String(error)); }
        }
        cursor = string(page.nextCursor);
        if (cursor && cursors.has(cursor)) throw new Error('Repeated loaded thread cursor');
        if (cursor) cursors.add(cursor);
    } while (cursor);
    return threads;
}

export async function listDesktopThreads(client: Pick<CodexAppServerClient, 'request'>,
    selection: Map<string, DesktopProject>, archived: Set<string>, since: number, workspace: string) {
    const threads: Record<string, unknown>[] = [];
    for (const id of selection.keys()) {
        if (archived.has(id)) continue;
        try {
            const thread = record(record(await client.request('thread/read', { threadId: id, includeTurns: false })).thread);
            if (thread.id === id && eligibleThread(thread, since, workspace)) threads.push(thread);
        } catch (error) { console.error(`Desktop member unavailable: ${id}`, String(error)); }
    }
    return threads;
}

export async function discoveryMain(): Promise<void> {
    const endpoint = process.env.HAPI_CODEX_EXTERNAL_ENDPOINT;
    const executable = process.env.HAPI_DISCOVERY_EXECUTABLE;
    const workspace = process.env.HAPI_DISCOVERY_WORKSPACE || homedir();
    const desktopState = process.env.HAPI_DISCOVERY_DESKTOP_STATE;
    const desktopHost = process.env.HAPI_DISCOVERY_DESKTOP_HOST;
    if (Boolean(desktopState) !== Boolean(desktopHost)) throw new Error('Desktop discovery requires state path and host ID');
    if (!endpoint?.startsWith('unix:///') || !executable) throw new Error('Discovery requires external endpoint and HAPI executable');
    const settings = await readSettings();
    if (!configuration.cliApiToken && settings.cliApiToken) configuration._setCliApiToken(settings.cliApiToken);
    if (!configuration.cliApiToken || !settings.machineId) throw new Error('Initialize the HAPI runner before discovery');
    const stateFile = join(configuration.happyHomeDir, 'codex-discovery.json');
    let since: number;
    try {
        const state = JSON.parse(await readFile(stateFile, 'utf8'));
        if (state.version !== 1 || !Number.isFinite(state.since)) throw new Error('Invalid discovery state');
        since = state.since;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        since = 0; // Include all unarchived history on first enablement.
        await writeFile(`${stateFile}.tmp`, JSON.stringify({ version: 1, since }), { mode: 0o600 });
        await rename(`${stateFile}.tmp`, stateFile);
    }
    const client = new CodexAppServerClient({ endpoint, cwd: workspace });
    const api = await ApiClient.create();
    const children = new Map<string, ChildProcess>();
    const retryAfter = new Map<string, number>();
    const readIdentity = createWorkspaceIdentityReader();
    let stopped = false;
    let wake: (() => void) | undefined;
    const stop = () => { stopped = true; wake?.(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    client.setServerRequestHandler(() => {});
    client.setNotificationHandler(method => { if (method === 'thread/started') wake?.(); });
    client.setTransportAbandonedHandler(() => { wake?.(); });
    console.log(`Discovery enabled since ${new Date(since * 1000).toISOString()} under ${workspace}`);
    try {
        while (!stopped) {
            try {
                if (!client.isInitialized()) await initializeSharedClient(client);
                const archived = await listArchivedThreadIds(client);
                const persisted = await listNewThreads(client, since, desktopState ? '/' : workspace);
                let selection: Map<string, DesktopProject> | undefined;
                if (desktopState && desktopHost) {
                    const state = JSON.parse(await readFile(desktopState, 'utf8'));
                    const paths = new Set([...desktopProjects(state, desktopHost).map(project => project.path),
                        ...persisted.map(thread => string(thread.cwd)).filter((path): path is string => Boolean(path))]);
                    const identities = new Map<string, WorkspaceIdentity>();
                    // Sequential, cached Git probes avoid a process burst for large sidebars.
                    for (const path of paths) identities.set(path, await readIdentity(path));
                    selection = desktopThreadSelection(state, desktopHost, persisted, identities);
                }
                const loaded = selection ? [] : await listLoadedNewThreads(client, since, workspace, archived);
                const threads = [...new Map([...persisted, ...loaded].filter(thread => !selection || selection.has(string(thread.id)!))
                    .map(thread => [thread.id, thread])).values()];
                const sessions = await api.listResumableSessions(settings.machineId);
                for (const session of sessions) {
                    if (session.flavor === 'codex' && session.agentSessionId && archived.has(session.agentSessionId)) {
                        await api.reconcileNativeArchive(session.sessionId, settings.machineId, session.agentSessionId);
                    }
                }
                const owners = (await readRuntimes({ strict: true })).filter(runtimeMayBeAlive);
                const creationPending = owners.some(owner => owner.pendingCreations?.length);
                const owned = new Set(owners.flatMap(owner => Object.values(owner.sessions).filter(s => s.active).map(s => s.threadId)));
                for (const thread of threads) {
                    if (stopped) break;
                    const id = string(thread.id)!;
                    if (children.has(id) || (retryAfter.get(id) ?? 0) > Date.now()) continue;
                    // One registry snapshot per scan avoids quadratic process probes.
                    // The runtime's ownership lock remains authoritative at attach.
                    if (creationPending || owned.has(id)) continue;
                    const existing = sessions.find(s => s.flavor === 'codex' && s.agentSessionId === id);
                    if (existing?.active) continue;
                    const args = ['codex', 'resume', id, '--started-by', 'runner',
                        ...(existing ? ['--existing-session-id', existing.sessionId] : [])];
                    const child = spawn(executable, args, { cwd: string(thread.cwd)!, stdio: 'inherit',
                        env: { ...process.env, CLI_API_TOKEN: configuration.cliApiToken, HAPI_CODEX_DISCOVERY: '1',
                            HAPI_CODEX_IMPORT_PROJECT_ROOT: selection?.get(id)?.path ?? '' }, windowsHide: true });
                    children.set(id, child);
                    const finished = () => { children.delete(id); retryAfter.set(id, Date.now() + 30_000); };
                    child.once('exit', finished);
                    child.once('error', error => { console.error(`Attach failed for ${id}: ${error.message}`); finished(); });
                    console.log(`Attaching native thread ${id}${existing ? ` to ${existing.sessionId}` : ''}`);
                }
            } catch (error) { console.error('Discovery retry:', error instanceof Error ? error.message : String(error)); }
            if (!stopped) await new Promise<void>(resolve => {
                const timer = setTimeout(() => { wake = undefined; resolve(); }, 15_000);
                wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
            });
        }
    } finally {
        client.setTransportAbandonedHandler(null);
        await client.disconnect();
        // Patched external runtimes detach without interrupting native turns.
        const exits = [...children.values()].map(child => new Promise<void>(resolve => {
            child.once('exit', () => resolve()); child.kill('SIGTERM');
        }));
        await Promise.all(exits);
        process.off('SIGTERM', stop); process.off('SIGINT', stop);
    }
}

if (import.meta.main) await discoveryMain();
