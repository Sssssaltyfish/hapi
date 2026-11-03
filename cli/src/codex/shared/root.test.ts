import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { SharedCodexRoot, type RootHost } from './root';
import { codexPlanProposalId } from './plan';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

type NativeTurn = { id: string; status: string; items: unknown[] };

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        initialized = false;
        thread = { id: 'thread', turns: [] as NativeTurn[] };
        settings: Record<string, unknown> = { model: 'mock', collaborationMode: { mode: 'default' } };
        goal: Record<string, unknown> | null = null;
        queue: Array<{ id: string; clientUserMessageId: unknown; input: unknown }> = [];
        steers: Record<string, unknown>[] = [];
        calls: Array<{ method: string; params: Record<string, unknown> }> = [];
        notify?: (method: string, params: unknown) => void;
        abandoned?: () => void;
        setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
        setTransportAbandonedHandler(handler: (() => void) | null) { this.abandoned = handler ?? undefined; }
        setServerRequestHandler() {}
        async connect() {}
        async initialize() { this.initialized = true; }
        isInitialized() { return this.initialized; }
        async disconnect() { this.initialized = false; }
        async request(method: string, params: Record<string, unknown> = {}) {
            this.calls.push({ method, params });
            if (method === 'thread/read' || method === 'thread/resume') return { ...this.settings, thread: structuredClone(this.thread) };
            if (method === 'thread/list') return { data: [] };
            if (method === 'thread/turns/list') return { data: [...this.thread.turns].reverse() };
            if (method === 'thread/compact/start' || method === 'thread/approveGuardianDeniedAction') return {};
            if (method === 'thread/sample') return { sourceTurnId: params.expectedTurnId, text: 'A separate recap.' };
            if (method === 'account/usage/read') return { summary: { lifetimeTokens: 123 } };
            if (method === 'account/rateLimits/read') return { rateLimits: {} };
            if (method === 'thread/goal/get') return { goal: this.goal };
            if (method === 'thread/goal/set') {
                this.goal = { threadId: 'thread', objective: 'Finish the work', status: 'active', ...this.goal, ...params };
                this.notify?.('thread/goal/updated', { threadId: 'thread', goal: this.goal });
                return { goal: this.goal };
            }
            if (method === 'thread/goal/clear') {
                this.goal = null;
                this.notify?.('thread/goal/cleared', { threadId: 'thread' });
                return { cleared: true };
            }
            if (method === 'thread/queue/list') return { data: this.queue };
            if (method === 'thread/settings/update') {
                this.settings = { ...this.settings, ...params };
                this.notify?.('thread/settings/updated', { threadId: 'thread', threadSettings: this.settings });
                return {};
            }
            if (method === 'thread/queue/add') {
                const entry = { id: `queued-${this.queue.length}`, clientUserMessageId: params.clientUserMessageId, input: params.input };
                this.queue.push(entry);
                return { queuedSubmission: entry };
            }
            if (method === 'thread/queue/delete') {
                this.queue = this.queue.filter(entry => entry.id !== params.queuedSubmissionId);
                return { deleted: true };
            }
            if (method === 'turn/steer') { this.steers.push(params); return {}; }
            throw new Error(`Unexpected request: ${method}`);
        }
    },
    isIndeterminateError: () => false
}));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({
    mcpServers: {}, server: { stop() {} }
}) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
    finally { vi.useRealTimers(); }
});

async function fixture(opts?: { hubArchived?: boolean; end?: RootHost['end']; nativeName?: string }) {
    const directory = await mkdtemp('/tmp/hapi-shared-root-');
    let state: AgentState = { steeringActive: true };
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex' };
    let reconnect: (() => void) | null = null;
    const updateState = vi.fn((fn: (value: AgentState) => AgentState) => { state = fn(state); });
    const rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const consumed = vi.fn();
    const events = vi.fn();
    let userMessage: ((message: { content: { text: string }; meta?: { deliveryMode?: 'steer' | 'queue' } }, localId: string) => void) | undefined;
    const uncertain = vi.fn();
    const hubArchivedListeners: Array<() => void> = [];
    const session = {
        sessionId: 'sid', getMetadata: () => metadata,
        hubArchived: opts?.hubArchived ?? false,
        updateMetadata: (fn: (value: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: updateState, keepAlive() {},
        onUserMessage(handler: typeof userMessage) { userMessage = handler; }, onCancelQueuedMessage() {}, onRetryQueuedMessage() {},
        onReconnect: (fn: (() => void) | null) => { reconnect = fn; },
        on(event: string, listener: () => void) {
            if (event === 'hub-archived') hubArchivedListeners.push(listener);
        },
        rpcHandlerManager: { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => rpc.set(name, handler) },
        sendSessionEvent: events, sendAgentMessage: send, emitSessionReady() {},
        sendUserMessage() {}, emitMessagesConsumed: consumed, emitSteerIndeterminate: uncertain, syncNativeQueuedMessage() {},
        sendSessionDeath() {}, async flush() {}, close() {}
    } as unknown as ApiSessionClient;
    const end = opts?.end ?? (async () => { throw new Error('Unexpected root archive'); });
    const root = new SharedCodexRoot({ session, workingDirectory: directory } as SessionBootstrapResult, {
        directory, generation: 'test', endpoint: 'mock', settingsFor: () => undefined,
        create: async () => { throw new Error('Unexpected root creation'); },
        end
    } satisfies RootHost);
    cleanups.push(async () => { await root.close(false); await rm(directory, { recursive: true, force: true }); });
    await root.prepare();
    await root.bind('thread', { model: 'mock', thread: { name: opts?.nativeName, turns: [] } }, false);
    const native = root.client as unknown as {
        initialized: boolean;
        thread: { id: string; name?: string; preview?: string; turns: NativeTurn[] };
        queue: Array<{ id: string; clientUserMessageId: string; input: unknown }>;
        steers: Record<string, unknown>[];
        calls: Array<{ method: string; params: Record<string, unknown> }>;
        notify(method: string, params: unknown): void;
        abandoned(): void;
    };
    return {
        root, native, rpc, send, events, consumed, uncertain, metadata: () => metadata, state: () => state, updateState,
        drain: () => (root as unknown as { notifications: Promise<void> }).notifications,
        reconnect: () => reconnect?.(),
        dropHubGoal: () => { state = { ...state, codexGoal: undefined, codexGoalUnavailable: undefined }; },
        emitHubArchived: () => { for (const listener of hubArchivedListeners) listener(); },
        hubArchivedListenerCount: () => hubArchivedListeners.length,
        end,
        userMessage: (text: string, localId: string, mode: 'steer' | 'queue') => userMessage?.({ content: { text }, meta: { deliveryMode: mode } }, localId),
    };
}

describe('native management command delivery', () => {
    it('dispatches management input without queueing a model turn and requires an exact one-time denial confirmation', async () => {
        const f = await fixture();
        f.native.thread.turns = [{ id: 'completed', status: 'completed', items: [] }];
        await f.root.activate();
        f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', approvalsReviewer: 'auto_review' } });
        for (const name of ['compact', 'recap', 'usage']) {
            f.userMessage(`/${name}`, name, 'steer');
            await vi.waitFor(() => expect(f.consumed).toHaveBeenCalledWith([name], expect.anything()));
        }
        f.native.notify('item/autoApprovalReview/completed', { threadId: 'thread', turnId: 'completed', reviewId: 'review',
            decisionSource: 'agent', review: { status: 'denied', rationale: 'Check this command' },
            action: { type: 'command', source: 'shell', command: 'echo exact', cwd: '/project' } });
        f.userMessage('/approve', 'show-review', 'queue');
        await vi.waitFor(() => expect(f.events.mock.calls.some(([event]) => String(event.message).includes('/approve review'))).toBe(true));
        expect(f.native.calls.some(call => call.method === 'thread/approveGuardianDeniedAction')).toBe(false);
        f.userMessage('/approve review', 'approve-review', 'queue');
        await vi.waitFor(() => expect(f.consumed).toHaveBeenCalledWith(['approve-review'], expect.anything()));
        f.userMessage('/approve review', 'duplicate-review', 'queue');
        await vi.waitFor(() => expect(f.events.mock.calls.some(([event]) => String(event.message).includes('no longer available'))).toBe(true));
        expect(f.native.calls.filter(call => call.method === 'thread/approveGuardianDeniedAction')).toHaveLength(1);
        expect(f.native.calls.some(call => ['thread/queue/add', 'turn/start', 'turn/steer'].includes(call.method))).toBe(false);
        expect(f.native.calls.find(call => call.method === 'thread/sample')?.params).toMatchObject({ threadId: 'thread', expectedTurnId: 'completed' });
    });
});

async function startCompaction(f: Awaited<ReturnType<typeof fixture>>, id = 'input', turnId = 'compacting-turn') {
    f.native.queue = [{ id: `native-${id}`, clientUserMessageId: id, input: [{ type: 'text', text: id }] }];
    await f.root.refresh();
    f.native.queue = [];
    // Native removes input before announcing the turn and before recording userMessage.
    f.native.notify('thread/queue/changed', { threadId: 'thread' });
    await vi.waitFor(() => expect(f.uncertain).toHaveBeenCalledWith(expect.arrayContaining([id])));
    const turn = { id: turnId, status: 'inProgress', items: [] };
    f.native.thread.turns.push(turn);
    f.native.notify('turn/started', { threadId: 'thread', turn });
    f.native.notify('item/started', { threadId: 'thread', turnId, item: { id: 'compact', type: 'contextCompaction' } });
    return turn;
}

describe('typed native goal controls', () => {
    it('round trips goal state through the native APIs without enqueueing a prompt', async () => {
        const f = await fixture();
        await f.root.activate();
        const control = f.rpc.get(RPC_METHODS.CodexGoalControl)!;
        expect(await control({ action: 'set', objective: 'pause' })).toMatchObject({ goal: { objective: 'pause', status: 'active' } });
        expect(f.state().codexGoal).toMatchObject({ objective: 'pause', status: 'active' });
        expect(await control({ action: 'pause' })).toMatchObject({ goal: { objective: 'pause', status: 'paused' } });
        expect(await control({ action: 'edit', objective: 'Revised pause', expectedObjective: 'pause' })).toMatchObject({ goal: { objective: 'Revised pause', status: 'paused' } });
        const edit = f.native.calls.filter(call => call.method === 'thread/goal/set').at(-1)!;
        expect(edit.params).toEqual({ threadId: 'thread', origin: 'user', objective: 'Revised pause' });
        await expect(control({ action: 'edit', objective: 'Stale', expectedObjective: 'pause' })).rejects.toThrow('changed elsewhere');
        expect(await control({ action: 'resume' })).toMatchObject({ goal: { objective: 'Revised pause', status: 'active' } });
        expect(await control({ action: 'clear' })).toEqual({ goal: null, cleared: true });
        expect(f.state().codexGoal).toBeNull();
        expect(f.native.queue).toEqual([]);
        expect(f.events).not.toHaveBeenCalled();
    });
    it('keeps a newer native notification when an earlier snapshot resolves late', async () => {
        const f = await fixture();
        await f.root.activate();
        let release!: (value: unknown) => void;
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation((method, params) => method === 'thread/goal/get'
            ? new Promise(resolve => { release = resolve; }) : request(method, params));
        const reading = f.rpc.get(RPC_METHODS.CodexGoalControl)!({ action: 'show' });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        f.native.notify('thread/goal/updated', { threadId: 'thread', goal: { threadId: 'thread', objective: 'New goal', status: 'paused' } });
        release({ goal: null });
        expect(await reading).toMatchObject({ goal: { objective: 'New goal', status: 'paused' } });
        expect(f.state().codexGoal).toMatchObject({ objective: 'New goal', status: 'paused' });
    });
    it('does not let a background read discard an acknowledged control before its notification arrives', async () => {
        const f = await fixture();
        await f.root.activate();
        const control = f.rpc.get(RPC_METHODS.CodexGoalControl)!;
        await control({ action: 'set', objective: 'Preserve the acknowledgement' });
        let release!: (value: unknown) => void;
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation((method, params) => method === 'thread/goal/set'
            ? new Promise(resolve => { release = resolve; }) : request(method, params));
        const pausing = control({ action: 'pause' });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await f.root.refresh();
        release({ goal: { ...f.state().codexGoal!, status: 'paused' } });
        expect(await pausing).toMatchObject({ goal: { status: 'paused' } });
        expect(f.state().codexGoal?.status).toBe('paused');
    });
    it('rejects invalid typed actions before calling the native runtime', async () => {
        const f = await fixture();
        await f.root.activate();
        const request = vi.spyOn(f.root.client, 'request');
        await expect(f.rpc.get(RPC_METHODS.CodexGoalControl)!({ action: 'set', objective: '' })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });
    it('reports an unavailable native goal feature without changing runtime flags', async () => {
        const f = await fixture();
        const request = f.root.client.request.bind(f.root.client);
        const calls = vi.spyOn(f.root.client, 'request').mockImplementation((method, params) => method === 'thread/goal/get'
            ? Promise.reject(new Error('goals feature is disabled')) : request(method, params));
        await f.root.refresh();
        expect(f.state().codexGoalUnavailable).toBe('goals feature is disabled');
        const updates = f.updateState.mock.calls.length;
        await f.root.refresh();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
        expect(calls.mock.calls.some(([method]) => method.startsWith('experimentalFeature/'))).toBe(false);
    });
    it('deduplicates identical reads and native notifications, but replays a lost Hub goal on reconnect', async () => {
        const f = await fixture();
        await f.root.activate();
        await f.rpc.get(RPC_METHODS.CodexGoalControl)!({ action: 'set', objective: 'Survive reconnect' });
        await f.drain();
        const updates = f.updateState.mock.calls.length;
        await f.root.refresh(); await f.root.refresh();
        f.native.notify('thread/goal/updated', { threadId: 'thread', goal: { ...f.state().codexGoal! } });
        await f.drain();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
        f.dropHubGoal();
        expect(f.state().codexGoal).toBeUndefined();
        f.reconnect();
        await vi.waitFor(() => expect(f.state().codexGoal?.objective).toBe('Survive reconnect'));
        const afterReconnect = f.updateState.mock.calls.length;
        await f.root.refresh();
        expect(f.updateState).toHaveBeenCalledTimes(afterReconnect);
    });
});

describe('default steer delivery', () => {
    it('steers a live send into the captured turn through the existing native queue', async () => {
        const f = await fixture();
        await f.root.activate();
        f.native.thread.turns = [{ id: 'active-at-receipt', status: 'inProgress', items: [] }];
        await f.root.refresh();
        f.userMessage('adjust this turn', 'direct-steer', 'steer');
        await vi.waitFor(() => expect(f.consumed).toHaveBeenCalledWith(['direct-steer'], { steered: true }));
        expect(f.native.steers).toEqual([expect.objectContaining({ expectedTurnId: 'active-at-receipt', clientUserMessageId: 'direct-steer' })]);
        expect(f.native.queue).toEqual([]);
    });
    it('keeps the message queued when the active turn changes during enqueue', async () => {
        const f = await fixture();
        await f.root.activate();
        f.native.thread.turns = [{ id: 'original', status: 'inProgress', items: [] }];
        await f.root.refresh();
        const request = f.root.client.request.bind(f.root.client);
        let release!: () => void;
        let started!: () => void;
        const enqueuing = new Promise<void>(resolve => { started = resolve; });
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/queue/add') {
                started();
                await new Promise<void>(resolve => { release = resolve; });
            }
            return request(method, params);
        });
        f.userMessage('for the original turn', 'generation-race', 'steer');
        await enqueuing;
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'replacement', status: 'inProgress', items: [] } });
        release();
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        await (f.root as unknown as { work: Promise<void> }).work;
        expect(f.native.steers).toEqual([]);
        expect(f.consumed).not.toHaveBeenCalled();
        expect(f.native.queue[0].clientUserMessageId).toBe('generation-race');
    });
    it('restores the same message after a definite steer rejection', async () => {
        const f = await fixture();
        await f.root.activate();
        f.native.thread.turns = [{ id: 'active', status: 'inProgress', items: [] }];
        await f.root.refresh();
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation((method, params) => {
            if (method === 'turn/steer') return Promise.reject(new Error('Turn already completed'));
            return request(method, params);
        });
        f.userMessage('preserve this input', 'rejected-steer', 'steer');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        await (f.root as unknown as { work: Promise<void> }).work;
        expect(f.native.queue).toEqual([expect.objectContaining({ clientUserMessageId: 'rejected-steer', input: [{ type: 'text', text: 'preserve this input' }] })]);
        expect(f.consumed).not.toHaveBeenCalled();
    });
    it('does not report a queued failure when native consumption wins before steer', async () => {
        const f = await fixture();
        await f.root.activate();
        f.native.thread.turns = [{ id: 'active', status: 'inProgress', items: [] }];
        await f.root.refresh();
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const response = await request(method, params);
            if (method === 'thread/queue/add') {
                f.native.queue = [];
                f.native.notify('item/started', { threadId: 'thread', turnId: 'active',
                    item: { id: 'native-input', type: 'userMessage', clientId: 'consumed-first', content: [] } });
                await f.drain();
            }
            return response;
        });
        f.userMessage('already accepted input', 'consumed-first', 'steer');
        await vi.waitFor(() => expect(f.consumed).toHaveBeenCalledWith(['consumed-first'], { steered: undefined }));
        await (f.root as unknown as { work: Promise<void> }).work;
        expect(f.native.steers).toEqual([]);
        expect(f.events).not.toHaveBeenCalled();
    });
    it('reports uncertainty when a rejected steer cannot be restored to the native queue', async () => {
        const f = await fixture();
        await f.root.activate();
        f.native.thread.turns = [{ id: 'active', status: 'inProgress', items: [] }];
        await f.root.refresh();
        const request = f.root.client.request.bind(f.root.client);
        let adds = 0;
        vi.spyOn(f.root.client, 'request').mockImplementation((method, params) => {
            if (method === 'turn/steer') return Promise.reject(new Error('Turn completed'));
            if (method === 'thread/queue/add' && ++adds > 1) return Promise.reject(new Error('Connection lost'));
            return request(method, params);
        });
        f.userMessage('preserve uncertain input', 'restore-failed', 'steer');
        await vi.waitFor(() => expect(f.uncertain).toHaveBeenCalledWith(['restore-failed']));
        await (f.root as unknown as { work: Promise<void> }).work;
        expect(f.consumed).not.toHaveBeenCalled();
        expect(f.events).toHaveBeenCalledWith({ type: 'message', message: 'Message delivery was not confirmed. Inspect the queue before retrying.' });
    });
});

describe('native title inheritance', () => {
    it('does not mistake stale historical turns for a currently running native thread', async () => {
        const f = await fixture();
        f.native.thread.turns = [{ id: 'stale', status: 'inProgress', items: [] }, { id: 'latest', status: 'completed', items: [] }];
        await f.root.refresh();
        expect(f.state().steeringActive).toBe(false);
        Object.assign(f.native.thread, { status: { type: 'idle' } });
        f.native.thread.turns = [{ id: 'stale', status: 'inProgress', items: [] }];
        await f.root.refresh();
        expect(f.state().steeringActive).toBe(false);
        Object.assign(f.native.thread, { status: { type: 'active' } });
        await f.root.refresh();
        expect(f.state().steeringActive).toBe(true);
    });
    it('uses the desktop first-message preview when the native thread has no explicit title', async () => {
        const f = await fixture();
        f.native.thread.preview = '把现在的改动同步到远端。';
        await f.root.refresh();
        expect(f.metadata().name).toBe('把现在的改动同步到远端。');
        f.native.thread.name = 'Explicit title';
        await f.root.refresh();
        expect(f.metadata().name).toBe('Explicit title');
    });
    it('inherits an existing native title during import and repairs it on refresh', async () => {
        const f = await fixture({ nativeName: 'Codex 侧标题' });
        expect(f.metadata().name).toBe('Codex 侧标题');
        f.native.thread.name = '离线时更新的标题';
        await f.root.refresh();
        expect(f.metadata().name).toBe('离线时更新的标题');
        delete f.native.thread.name;
        await f.root.refresh();
        expect(f.metadata().name).toBe('离线时更新的标题');
    });
    it('does not let an older snapshot overwrite a live rename', async () => {
        const f = await fixture({ nativeName: 'Original' });
        let release!: (thread: Record<string, unknown>) => void;
        vi.spyOn(f.root, 'readThread').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const refresh = f.root.refresh();
        f.native.notify('thread/name/updated', { threadId: 'thread', threadName: 'Latest' });
        await f.drain();
        release({ id: 'thread', name: 'Stale', turns: [] });
        await refresh;
        expect(f.metadata().name).toBe('Latest');
    });
});

describe('compaction delivery confirmation', () => {
    it('does not turn uncertainty discovered by a cold snapshot into live compaction evidence', async () => {
        const f = await fixture();
        f.native.queue = [{ id: 'old-native', clientUserMessageId: 'old', input: [] }];
        await f.root.refresh();
        f.native.queue = [];
        await f.root.refresh();
        expect(f.uncertain).toHaveBeenCalledWith(['old']);
        f.native.thread.turns.push({ id: 'later', status: 'inProgress', items: [] });
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'later' } });
        f.native.notify('item/started', { threadId: 'thread', turnId: 'later', item: { id: 'c', type: 'contextCompaction' } });
        await f.drain();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
    });

    it('reports only freshly dequeued input as waiting, without acknowledging or replaying it', async () => {
        const f = await fixture();
        const request = vi.spyOn(f.root.client, 'request');
        const turn = await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        expect(f.consumed).not.toHaveBeenCalled();
        expect(request.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false);
        f.native.notify('item/started', { threadId: 'thread', turnId: turn.id,
            item: { id: 'user', type: 'userMessage', clientId: 'input', content: [] } });
        await vi.waitFor(() => expect(f.consumed).toHaveBeenCalledWith(['input'], { steered: undefined }));
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
    });

    it.each(['completed', 'interrupted', 'failed'])('restores uncertainty when the turn is %s without consumption', async status => {
        const f = await fixture();
        const turn = await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        turn.status = status;
        f.native.notify('turn/completed', { threadId: 'thread', turn });
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] }));
        expect(f.consumed).not.toHaveBeenCalled();
        await startCompaction(f, 'next', 'next-turn');
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['next'] }));
    });

    it('withdraws waiting at compaction completion and ignores child and stale turn events', async () => {
        const f = await fixture();
        const turn = await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        for (const [threadId, turnId] of [['child', turn.id], ['thread', 'stale']]) {
            f.native.notify('item/completed', { threadId, turnId, item: { id: 'other', type: 'contextCompaction' } });
        }
        await f.drain();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] });
        f.native.notify('item/completed', { threadId: 'thread', turnId: turn.id, item: { id: 'compact', type: 'contextCompaction' } });
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] }));
        expect(f.consumed).not.toHaveBeenCalled();
    });

    it('does not keep waiting after native disconnect or stopping', async () => {
        const f = await fixture();
        await startCompaction(f);
        await vi.waitFor(() => expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: ['input'] }));
        f.native.initialized = false;
        f.native.abandoned();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
        await vi.waitFor(() => expect(f.native.initialized).toBe(true));
        await f.root.refresh();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
        f.root.stopAccepting();
        expect(f.state()).toMatchObject({ codexCompactionPendingMessageIds: [] });
    });
});

async function completePlan(f: Awaited<ReturnType<typeof fixture>>, status = 'completed') {
    await f.root.applySettings({ collaborationMode: 'plan' });
    const turn = { id: 'plan-turn', status: 'inProgress', items: [{ id: 'plan-item', type: 'plan', text: '# Implement me' }] };
    f.native.thread.turns.push(turn);
    f.native.notify('turn/started', { threadId: 'thread', turn: { id: turn.id } });
    f.native.notify('item/completed', { threadId: 'thread', turnId: turn.id, item: turn.items[0] });
    expect(f.state().codexPlanProposalId).toBeNull();
    turn.status = status;
    f.native.notify('turn/completed', { threadId: 'thread', turn: { id: turn.id, status } });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'ExitPlanMode' }), expect.any(String)));
    return codexPlanProposalId('thread', turn.id, 'plan-item');
}

describe('shared permission modes', () => {
    it('switches native auto-review on and back to the human reviewer', async () => {
        const f = await fixture();
        expect((await f.root.applySettings({ permissionMode: 'autoReview' })).applied.permissionMode).toBe('autoReview');
        expect(f.root.client).toMatchObject({ settings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } } });
        expect((await f.root.applySettings({ permissionMode: 'default' })).applied.permissionMode).toBe('default');
        expect(f.root.client).toMatchObject({ settings: { approvalsReviewer: 'user' } });
    });
});

describe('shared plan actions', () => {
    it('applies remote change_title as metadata.name then lets native terminal rename win', async () => {
        const f = await fixture();
        const item = { id: 'title', type: 'mcpToolCall', server: 'hapi', tool: 'change_title',
            arguments: { title: 'Remote title' }, status: 'completed', result: { content: [], isError: false } };
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Remote title'));
        f.native.notify('thread/name/updated', { threadId: 'thread', threadName: 'Terminal title' });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Terminal title'));
        await f.root.refresh();
        expect(f.metadata().name).toBe('Terminal title');
    });

    it('preserves content while native turns, mode changes and disconnects withdraw controls', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        expect(f.state().codexPlanProposalId).toBe(id);
        expect(f.state().requests).toEqual({});
        await f.root.applySettings({ collaborationMode: 'default' });
        expect(f.state().codexPlanProposalId).toBeNull();
        await f.root.applySettings({ collaborationMode: 'plan' });
        expect(f.state().codexPlanProposalId).toBe(id);
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().codexPlanProposalId).toBeNull();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'new' } });
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'plan-turn', status: 'completed' } });
        expect(f.state().codexPlanProposalId).toBeNull();
        expect(f.send.mock.calls.some(([message]) => message.input?.plan === '# Implement me')).toBe(true);
    });

    it.each(['failed', 'interrupted'])('does not offer a proposal from a %s turn', async status => {
        const f = await fixture();
        await completePlan(f, status);
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('uses only the latest root turn when replaying history', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        f.reconnect();
        await f.root.refresh();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.thread.turns.push({ id: 'new', status: 'completed', items: [] });
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
        f.native.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'p', type: 'plan', text: 'child' } });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('switches mode and submits once across repeated Web actions and lost replies', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        const request = vi.spyOn(f.root.client, 'request');
        expect(await Promise.all([action(), action()])).toEqual([{ ok: true }, { ok: true }]);
        f.reconnect();
        expect(await action()).toEqual({ ok: true });
        expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
        const settingsIndex = request.mock.calls.findIndex(([method]) => method === 'thread/settings/update');
        const queueIndex = request.mock.calls.findIndex(([method]) => method === 'thread/queue/add');
        expect(settingsIndex).toBeLessThan(queueIndex);
        expect(request.mock.calls[settingsIndex][1]).toMatchObject({ collaborationMode: { mode: 'default' } });
        expect(f.native.queue[0]).toMatchObject({ input: [{ type: 'text', text: 'Implement the plan.' }] });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not let a slow history snapshot resurrect a plan after native continuation', async () => {
        const f = await fixture();
        await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        let reading!: () => void;
        const started = new Promise<void>(resolve => { reading = resolve; });
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns) {
                reading(); await blocked;
            }
            return result;
        });
        const refresh = f.root.refresh();
        await started;
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal-continued' } });
        release(); await refresh;
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not change mode when native input appears during the action preflight', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/queue/list') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id })).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(spy.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect(f.native.queue).toHaveLength(0);
    });

    it('rejects stale proposals and native activity arriving during the mode switch', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = (planId = id) => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId });
        expect(await action('old')).toMatchObject({ ok: false, code: 'stale_plan' });
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/settings/update') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await action()).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(f.native.queue).toHaveLength(0);
    });

    it('does not resend an implementation with an unknown queue outcome', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            // An invalid response schema leaves delivery indeterminate even after acceptance.
            return method === 'thread/queue/add' ? {} : result;
        });
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        f.native.queue = []; // Absence is not proof of cancellation or delivery.
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        expect(spy.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
    });
});

describe('shared steering availability', () => {
    it('keeps idle sessions online without polling usage or publishing agent-state updates', async () => {
        const f = await fixture();
        const requests = vi.spyOn(f.root.client, 'request');
        const heartbeat = vi.spyOn(f.root.session, 'keepAlive');
        const updates = f.updateState.mock.calls.length;
        vi.useFakeTimers();

        await f.root.activate();
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(heartbeat).toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
    });

    it('publishes root turn transitions, ignores child turns, and clears on shutdown', async () => {
        const f = await fixture();
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'old-turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'next' } });
        f.root.stopAccepting();
        expect(f.state().steeringActive).toBe(false);
    });

    it('reconciles native and Hub reconnects without publishing on every refresh', async () => {
        const f = await fixture();
        const updates = f.updateState.mock.calls.length;
        await f.root.refresh(); await f.root.refresh();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
        f.native.thread.turns = [{ id: 'busy', status: 'inProgress', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().steeringActive).toBe(false);
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.thread.turns = [{ id: 'busy', status: 'completed', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(false));
    });

    it('ends the shared root on hub-archived metadata (#1911 C2 / AC6)', async () => {
        const end = vi.fn<RootHost['end']>(async () => {});
        const f = await fixture({ end });
        await f.root.activate();
        expect(f.hubArchivedListenerCount()).toBe(1);
        f.emitHubArchived();
        await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
        expect(end.mock.calls[0]?.[0]).toBe(f.root);
    });

    it('ends when hubArchived was latched before activate (production order, #1911 AC6)', async () => {
        // Bootstrap may refuse CAS / noteHubArchived before Codex bind+activate
        // registers controls — same late-listener miss as other flavors.
        const end = vi.fn<RootHost['end']>(async () => {});
        const f = await fixture({ hubArchived: true, end });
        await f.root.activate();
        await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    });
});
