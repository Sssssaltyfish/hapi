import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';

const test = vi.hoisted(() => ({ home: '', requests: [] as Array<[string, unknown]>, root: null as any, spawn: vi.fn(), kill: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: test.spawn }));
vi.mock('@/configuration', () => ({ configuration: { apiUrl: 'http://test-hub' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/utils/process', () => ({ getProcessStartMarker: () => 'test-generation', killProcessByChildProcess: test.kill }));
vi.mock('@/runner/controlClient', () => ({ notifyRunnerSessionStarted: vi.fn(async () => {}) }));
vi.mock('./registry', () => ({ codexHome: () => test.home, runtimeDirectory: () => test.home,
    runtimeAuthHash: () => 'test', saveRuntime: vi.fn(async () => {}), findColdBinding: vi.fn(async () => undefined),
    withThreadOwnership: async (_home: string, _id: string, _owner: string, work: () => unknown) => work() }));
vi.mock('./launch', () => ({ resolveSharedCodex: () => ({ command: 'codex', args: [] }),
    sharedLaunchConfig: () => ({ cwd: test.home, serverArgs: [], threadParams: { model: 'must-not-override', developerInstructions: 'must-not-override' } }),
    initializeSharedClient: vi.fn(async () => {}), checkSharedCapabilities: vi.fn(async () => {}), takeReservedSessionId: () => undefined }));
const thread = () => ({ id: 'desktop-thread', cwd: test.home, turns: [] });
vi.mock('../codexAppServerClient', () => ({ isIndeterminateError: () => false,
    CodexAppServerClient: class {
        setServerRequestHandler() {} setNotificationHandler() {} setTransportAbandonedHandler() {}
        async disconnect() {} isInitialized() { return true; }
        async request(method: string, params: unknown) { test.requests.push([method, params]); return { thread: thread() }; }
    } }));
vi.mock('./gateway', async original => ({ ...await original<typeof import('./gateway')>(),
    startCodexGateway: vi.fn(async () => ({ endpoint: 'unix:///tmp/test-client.sock', close: vi.fn(async () => {}) })) }));
vi.mock('@/agent/sessionFactory', () => ({ bootstrapSession: async () => ({
    workingDirectory: test.home, sessionInfo: { namespace: 'test' }, metadata: {},
    session: { sessionId: 'hapi-test', flush: vi.fn(async () => {}), getMetadata: () => ({}) }
}), bootstrapExistingSession: vi.fn() }));
vi.mock('./root', async () => {
    const { CodexAppServerClient } = await import('../codexAppServerClient');
    return { SharedCodexRoot: class {
        client = new CodexAppServerClient(); threadId = '';
        prepare = vi.fn(async () => {}); activate = vi.fn(async () => {});
        suspend = vi.fn(async () => {}); close = vi.fn(async () => {}); stopAccepting = vi.fn();
        constructor(readonly bootstrap: any) { test.root = this; }
        get session() { return this.bootstrap.session; }
        async bind(id: string) { this.threadId = id; }
    } };
});

afterEach(async () => { vi.unstubAllEnvs(); if (test.home) await rm(test.home, { recursive: true, force: true }); test.requests = []; vi.clearAllMocks(); });
it('attaches without spawning, preserves desktop resume configuration, and detaches without draining or stopping its daemon', async () => {
    test.home = await mkdtemp('/tmp/hapi-external-test-');
    vi.stubEnv('HAPI_CODEX_EXTERNAL_ENDPOINT', 'unix:///tmp/desktop.sock');
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const { runSharedRuntime } = await import('./runtime');
    const running = runSharedRuntime({ workingDirectory: test.home, resumeSessionId: 'desktop-thread', model: 'must-not-override' }, ready, controller.signal);
    try {
        await Promise.race([started, running.then(() => { throw new Error('Exited before attach'); })]);
        expect(test.spawn).not.toHaveBeenCalled();
        expect(test.requests.filter(([method]) => method === 'thread/resume').every(([, params]) => JSON.stringify(params) === JSON.stringify({ threadId: 'desktop-thread' }))).toBe(true);
        expect(test.requests.some(([method]) => method === 'thread/metadata/update')).toBe(false);
        expect(test.root.activate).toHaveBeenCalledWith({});
    } finally { controller.abort(); await running; }
    expect(test.root.suspend).not.toHaveBeenCalled();
    expect(test.root.close).toHaveBeenCalledWith(false);
    expect(test.kill).not.toHaveBeenCalled();
});
