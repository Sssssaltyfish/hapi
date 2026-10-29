import { expect, it } from 'vitest';
import { desktopThreadSelection } from './desktopSelection';
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
it('uses explicit current project membership and excludes deleted/foreign entries', () => {
    expect([...desktopThreadSelection(state(), 'wsl').keys()]).toEqual(['root']);
    expect(() => desktopThreadSelection({}, 'wsl')).toThrow('suspended');
    expect(desktopThreadSelection({ ...state(), 'remote-projects': [] }, 'wsl').size).toBe(0);
});
it('never scans neighboring validation runs or loaded threads', async () => {
    const calls: string[] = [];
    const client = { request: async (method: string, params: any) => {
        expect(method).toBe('thread/read'); calls.push(params.threadId);
        return { thread: { id: params.threadId, cwd: '/home/example', createdAt: 100, source: 'vscode', name: 'Desktop title' } };
    }};
    const threads = await listDesktopThreads(client as any, desktopThreadSelection(state(), 'wsl'), new Set(), 0, '/home/example');
    expect(calls).toEqual(['root']);
    expect(threads.map(t => t.name)).toEqual(['Desktop title']);
    calls.length = 0;
    expect(await listDesktopThreads(client as any, desktopThreadSelection(state(), 'wsl'), new Set(['root']), 0, '/home/example')).toEqual([]);
    expect(calls).toEqual([]);
});

it('includes user-confirmed legacy/worktree members without broadening directory discovery', () => {
    const selection = desktopThreadSelection(state(), 'wsl', { root: 'p', worktree1: 'p', worktree2: 'p', legacy: 'p' });
    expect([...selection.keys()]).toEqual(['root', 'worktree1', 'worktree2', 'legacy']);
    expect(selection.get('worktree1')?.path).toBe('/home/example');
    expect(selection.has('validation-run')).toBe(false);
    expect(() => desktopThreadSelection(state(), 'wsl', { child: 'missing-project' })).toThrow();
});
