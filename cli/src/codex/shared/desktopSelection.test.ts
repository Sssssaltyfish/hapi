import { expect, it } from 'vitest';
import { desktopThreadSelection, type WorkspaceIdentity } from './desktopSelection';
import { listDesktopThreads } from './discovery';

function state() {
    return {
        'remote-projects': [{ id: 'p', hostId: 'wsl', label: 'Project', remotePath: '/home/example' },
            { id: 'other', hostId: 'ssh', label: 'Other', remotePath: '/home/example' }],
        'thread-project-assignments': {
            root: { projectKind: 'remote', projectId: 'p', hostId: 'wsl' },
            removed: { projectKind: 'remote', projectId: 'p', hostId: 'wsl' },
            foreign: { projectKind: 'remote', projectId: 'other', hostId: 'ssh' },
            orphan: { projectKind: 'remote', projectId: 'deleted-project', hostId: 'wsl' }
        },
        'electron-persisted-atom-state': { 'codex-writing-block-deleted-thread-v1:removed': true }
    };
}
const threads = ['root', 'removed'].map(id => ({ id, cwd: '/elsewhere', source: 'vscode' }));
it('uses explicit current project membership and excludes deleted entries', () => {
    expect([...desktopThreadSelection(state(), 'wsl', threads).keys()]).toEqual(['root']);
    expect(() => desktopThreadSelection({}, 'wsl', threads)).toThrow('suspended');
    expect(desktopThreadSelection({ ...state(), 'remote-projects': [] }, 'wsl', threads).size).toBe(0);
});
it('never scans neighboring validation runs or loaded threads', async () => {
    const calls: string[] = [];
    const client = { request: async (method: string, params: any) => {
        expect(method).toBe('thread/read'); calls.push(params.threadId);
        return { thread: { id: params.threadId, cwd: '/home/example', createdAt: 100, source: 'vscode', name: 'Desktop title' } };
    }};
    const listed = await listDesktopThreads(client as any, desktopThreadSelection(state(), 'wsl', threads), new Set(), 0, '/home/example');
    expect(calls).toEqual(['root']);
    expect(listed.map(t => t.name)).toEqual(['Desktop title']);
    calls.length = 0;
    expect(await listDesktopThreads(client as any, desktopThreadSelection(state(), 'wsl', threads), new Set(['root']), 0, '/home/example')).toEqual([]);
    expect(calls).toEqual([]);
});

it('automatically includes new cwd and linked worktree chats without an ID allowlist', () => {
    const values = [
        { id: 'new', cwd: '/home/example', source: 'vscode', threadSource: 'agent_created_thread' },
        { id: 'worktree', cwd: '/home/.codex/worktrees/random/repo', source: 'vscode' },
        { id: 'validation', cwd: '/home/example/validation-runs/run', source: 'vscode' },
        { id: 'exec', cwd: '/home/example', source: 'exec' },
        { id: 'child', cwd: '/home/example', source: { subAgent: {} } },
        { id: 'ambient', cwd: '/home/example', source: 'vscode', threadSource: 'ambient_suggestions' }
    ];
    const identities = new Map<string, WorkspaceIdentity>([
        ['/home/example', { path: '/home/example', git: { root: '/home/example', commonDir: '/home/example/.git' } }],
        [values[1].cwd, { path: values[1].cwd, git: { root: values[1].cwd, commonDir: '/home/example/.git' } }]
    ]);
    const selection = desktopThreadSelection(state(), 'wsl', values, identities);
    expect([...selection.keys()]).toEqual(['new', 'worktree']);
    expect(selection.get('worktree')?.path).toBe('/home/example');
});
it('honors projectless, canonical paths, and explicit assignment precedence', () => {
    const s = { ...state(), 'projectless-thread-ids': ['root', 'detached'] };
    const values = [...threads, { id: 'detached', cwd: '/home/example', source: 'vscode' },
        { id: 'alias', cwd: '/alias', source: 'vscode' }];
    const identities = new Map([['/alias', { path: '/home/example' }]]);
    expect([...desktopThreadSelection(s, 'wsl', values, identities).keys()]).toEqual(['root', 'alias']);
});
