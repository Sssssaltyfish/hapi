import { expect, it } from 'vitest';
import { eligibleThread, listNewThreads, listLoadedNewThreads } from './discovery';

it('excludes history, subagents, temporary threads and directories outside the runner workspace', () => {
    const base = { id: 'new', cwd: '/home/igna/project', createdAt: 101, source: 'vscode' };
    expect(eligibleThread(base, 100, '/home/igna')).toBe(true);
    for (const change of [{ createdAt: 99 }, { parentThreadId: 'parent' }, { parent_thread_id: 'parent' },
        { source: 'exec' }, { source: 'subAgentThreadSpawn' }, { source: 'subagent' },
        { source: { subAgent: {} } }, { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } },
        { source: { sub_agent: 'review' } },
        { ephemeral: true }, { archived: true }, { cwd: '/home/igna-other' }, { cwd: '/tmp' }]) {
        expect(eligibleThread({ ...base, ...change }, 100, '/home/igna')).toBe(false);
    }
});

it('excludes helpers from both persisted and loaded discovery, even when the server ignores source filters', async () => {
    const threads = [
        { id: 'desktop', source: 'vscode' }, { id: 'terminal', source: 'cli' },
        { id: 'helper', source: 'exec' },
        { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'desktop' } } } },
        { id: 'review', source: 'subAgentReview' }
    ].map(t => ({ ...t, cwd: '/home/example', createdAt: 101 }));
    const client = { request: async (method: string, params: any) => {
        if (method === 'thread/list') {
            if (params.archived) return { data: [] };
            expect(params.sourceKinds).not.toContain('exec');
            return { data: threads };
        }
        if (method === 'thread/loaded/list') return { data: threads.map(t => t.id) };
        return { thread: threads.find(t => t.id === params.threadId) };
    }};
    expect((await listNewThreads(client as any, 0, '/home/example')).map(t => t.id)).toEqual(['desktop', 'terminal']);
    expect((await listLoadedNewThreads(client as any, 0, '/home/example')).map(t => t.id)).toEqual(['desktop', 'terminal']);
});

it('discovers a loaded empty thread that the persisted history listing omits', async () => {
    const client = { request: async (method: string, params: any) => method === 'thread/loaded/list'
        ? { data: ['blank', 'old'] }
        : method === 'thread/list' ? { data: [] }
        : { thread: { id: params.threadId, cwd: '/home/igna', createdAt: params.threadId === 'blank' ? 101 : 50 } } };
    expect((await listLoadedNewThreads(client as any, 100, '/home/igna')).map(t => t.id)).toEqual(['blank']);
});

it('does not resume archived loaded history when thread/read has no archived flag', async () => {
    const reads: string[] = [];
    const client = { request: async (method: string, params: any) => {
        if (method === 'thread/list') return params.cursor ? {data:[{id:'archived2'}]} : {data:[{id:'archived'}],nextCursor:'p2'};
        if (method === 'thread/loaded/list') return {data:['archived','archived2','blank']};
        reads.push(params.threadId);
        return {thread:{id:params.threadId,cwd:'/home/igna',createdAt:101}};
    }};
    expect((await listLoadedNewThreads(client as any,0,'/home/igna')).map(t=>t.id)).toEqual(['blank']);
    expect(reads).toEqual(['blank']);
});

it('finds every new thread across pages after downtime and stops at the persisted cutoff', async () => {
    const cursors: unknown[] = [];
    const pages = [
        { data: [{ id: 'a', cwd: '/home/igna', createdAt: 110 }], nextCursor: 'p2' },
        { data: [{ id: 'b', cwd: '/home/igna', createdAt: 101 }, { id: 'old', createdAt: 90 }], nextCursor: 'unused' }
    ];
    const client = { request: async (_method: string, params: any) => { cursors.push(params.cursor); return pages.shift(); } };
    expect((await listNewThreads(client as any, 100, '/home/igna')).map(t => t.id)).toEqual(['a', 'b']);
    expect(cursors).toEqual([undefined, 'p2']);
});
