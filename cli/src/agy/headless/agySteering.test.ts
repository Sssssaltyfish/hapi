import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { AgySession } from '../session';
import type { AgyMode } from '../types';
import { AgySteering } from './agySteering';

const CONVERSATION = '51997175-8ed0-465f-a7e6-7527e35bbb62';
const MODE: AgyMode = { permissionMode: 'request-review' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hapi-agy-steering-'));
    const workspace = join(root, 'workspace');
    const artifact = join(root, CONVERSATION);
    const transcript = join(artifact, '.system_generated', 'logs', 'transcript_full.jsonl');
    await mkdir(workspace);
    await mkdir(join(artifact, '.system_generated', 'logs'), { recursive: true });
    await writeFile(transcript, JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'original' }) + '\n');
    const queue = new MessageQueue2<AgyMode>(mode => `${mode.permissionMode}:${mode.model ?? ''}`);
    let metadata: any = {};
    let state: any = {};
    let steer!: (id: string) => Promise<{ steered: boolean; error?: string }>;
    const client = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        updateMetadata: vi.fn((update: (meta: any) => any) => { metadata = update(metadata); }),
        updateAgentState: vi.fn((update: (state: any) => any) => { state = update(state); }),
        setSteerDeliveryState: vi.fn(async () => true),
        emitMessagesConsumed: vi.fn(), emitSteerIndeterminate: vi.fn(),
    };
    const session = { path: workspace, queue, client,
        registerQueuedSteerHandler: (handler: typeof steer) => { steer = handler; return () => {}; },
    } as unknown as AgySession;
    const steering = new AgySteering(session);
    await steering.start();
    const lease = steering.beginTurn(queue.modeHasher(MODE), CONVERSATION);
    const hook = { conversationId: CONVERSATION, invocationNum: 0, initialNumSteps: 1,
        workspacePaths: [workspace, lease.addDirectory!], artifactDirectoryPath: artifact, transcriptPath: transcript };
    cleanups.push(async () => { await steering.close(); await rm(root, { recursive: true, force: true }); });
    const call = (event: 'pre' | 'post' = 'pre', override: Record<string, unknown> = {}) =>
        steering.handleHook(event, lease.env.HAPI_AGY_HOOK_GENERATION, { ...hook, ...override });
    const receipt = async (text: string, step = 1) => {
        await appendFile(transcript, JSON.stringify({ step_index: step, source: 'SYSTEM_SDK', type: 'USER_INPUT', status: 'DONE',
            content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>test</ADDITIONAL_METADATA>` }) + '\n');
    };
    return { steering, queue, client, lease, hook, transcript, call, receipt,
        steer: (id: string) => steer(id), metadata: () => metadata, state: () => state };
}

describe('AGY documented hook steering', () => {
    it('loads a fixed session overlay, verifies the live hook, and consumes only a native receipt', async () => {
        const f = await fixture();
        expect(f.metadata().capabilities.steering).toBe(false);
        expect(f.state().steeringActive).toBe(false);
        const settings = JSON.parse(await readFile(join(f.lease.addDirectory!, '.agents', 'hooks.json'), 'utf8'));
        expect(Object.keys(settings)).toEqual(['hapi-session-steering']);
        expect(settings['hapi-session-steering'].PreInvocation[0].command).toContain('agy-hook');
        expect(settings['hapi-session-steering'].PostInvocation[0].command).toContain('post');
        await f.call();
        expect(f.metadata().capabilities.steering).toBe(true);
        expect(f.state().steeringActive).toBe(true);
        f.queue.push('ordinary queue', MODE, 'queue');
        f.queue.push('use 中文 now', MODE, 'steer');
        const result = f.steer('steer');
        await vi.waitFor(() => expect(f.client.setSteerDeliveryState).toHaveBeenCalledWith(['steer'], 'dispatching'));
        await Promise.resolve();
        const output = await f.call('post');
        expect(output).toEqual({ injectSteps: [{ userMessage: 'use 中文 now' }], terminationBehavior: 'force_continue' });
        expect(f.queue.pendingLocalIds()).toEqual(['queue']);
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        await f.receipt('different body', 1);
        await f.steering.checkReceipts();
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        await f.receipt('use 中文 now', 2);
        await f.steering.checkReceipts();
        expect(await result).toEqual({ steered: false, pending: true });
        expect(f.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['steer'], { steered: true });
        await f.steering.finishTurn();
        const second = f.steering.beginTurn(f.queue.modeHasher(MODE), CONVERSATION);
        expect(second.addDirectory).toBe(f.lease.addDirectory);
        expect(second.env.HAPI_AGY_HOOK_GENERATION).not.toBe(f.lease.env.HAPI_AGY_HOOK_GENERATION);
        await f.steering.close();
        await expect(access(f.lease.addDirectory!)).rejects.toThrow();
    });

    it('never takes a normal message or injects across generation, conversation, or mode changes', async () => {
        const f = await fixture();
        f.queue.push('normal', MODE, 'normal');
        expect(await f.steering.handleHook('pre', 'old-generation', f.hook)).toEqual({});
        expect(f.metadata().capabilities.steering).toBe(false);
        expect(await f.call('pre', { conversationId: 'af3d140d-94a4-4379-9e42-acac3a7bb1ba' })).toEqual({});
        await f.call();
        expect(await f.call()).toEqual({});
        expect(f.queue.pendingLocalIds()).toEqual(['normal']);
        f.queue.push('other model', { ...MODE, model: 'different' }, 'other');
        expect(await f.steer('other')).toMatchObject({ steered: false });
        expect(f.queue.pendingLocalIds()).toEqual(['normal', 'other']);
        expect(f.client.setSteerDeliveryState).not.toHaveBeenCalled();
    });

    it('restores an unoffered steer in FIFO order when the turn completes first', async () => {
        const f = await fixture();
        await f.call();
        f.queue.push('first', MODE, 'first');
        f.queue.push('follow-up', MODE, 'steer');
        f.queue.push('last', MODE, 'last');
        const result = f.steer('steer');
        await vi.waitFor(() => expect(f.client.setSteerDeliveryState).toHaveBeenCalled());
        await f.steering.finishTurn();
        expect(await result).toMatchObject({ steered: false });
        expect(f.queue.pendingLocalIds()).toEqual(['first', 'steer', 'last']);
        expect(f.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['steer'], 'queued');
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(f.client.emitSteerIndeterminate).not.toHaveBeenCalled();
    });

    it('cancels a reserved steer before the hook and blocks cancellation after dispatch', async () => {
        const f = await fixture();
        await f.call();
        f.queue.push('cancel me', MODE, 'cancel');
        const cancelled = f.steer('cancel');
        expect(f.steering.cancel('cancel')).toBe(true);
        expect(await cancelled).toMatchObject({ steered: false });
        expect(await f.call()).toEqual({});
        f.queue.push('already offered', MODE, 'offered');
        const offered = f.steer('offered');
        await vi.waitFor(() => expect(f.client.setSteerDeliveryState).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        expect(await f.call()).toHaveProperty('injectSteps');
        expect(f.steering.cancel('offered')).toBe('in-flight');
        await f.receipt('already offered');
        await f.steering.checkReceipts();
        expect(await offered).toEqual({ steered: false, pending: true });
    });

    it('holds an offered message without receipt through process failure and refuses automatic replay', async () => {
        const f = await fixture();
        await f.call();
        f.queue.push('unknown injection', MODE, 'unknown');
        const result = f.steer('unknown');
        await vi.waitFor(() => expect(f.client.setSteerDeliveryState).toHaveBeenCalled());
        await Promise.resolve();
        expect(await f.call()).toHaveProperty('injectSteps');
        await f.steering.finishTurn();
        expect(await result).toMatchObject({ steered: false });
        expect(f.client.emitSteerIndeterminate).toHaveBeenCalledExactlyOnceWith(['unknown']);
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(f.queue.size()).toBe(0);
        const lease = f.steering.beginTurn(f.queue.modeHasher(MODE), CONVERSATION);
        await f.steering.handleHook('pre', lease.env.HAPI_AGY_HOOK_GENERATION, f.hook);
        expect(await f.steer('unknown')).toMatchObject({ steered: false });
        expect(f.queue.size()).toBe(0);
        expect(f.queue.cancelByLocalId('unknown')).toBe(true);
    });

    it('holds shutdown and failed persistence without a consumed ACK', async () => {
        const f = await fixture();
        await f.call();
        f.queue.push('shutdown pending', MODE, 'exit');
        const result = f.steer('exit');
        await vi.waitFor(() => expect(f.client.setSteerDeliveryState).toHaveBeenCalled());
        f.steering.stopAccepting(true);
        await f.steering.finishTurn();
        expect(await result).toMatchObject({ steered: false });
        expect(f.client.emitSteerIndeterminate).toHaveBeenCalledWith(['exit']);
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it('does not mistake an earlier identical native message for this delivery', async () => {
        const f = await fixture();
        await f.receipt('same body', 1);
        await f.call();
        f.queue.push('same body', MODE, 'new-delivery');
        expect(await f.steer('new-delivery')).toEqual({ steered: false, pending: true });
        expect(await f.call('pre', { initialNumSteps: 2 })).toHaveProperty('injectSteps');
        await f.steering.checkReceipts();
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        await f.receipt('same body', 2);
        await f.steering.checkReceipts();
        expect(f.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['new-delivery'], { steered: true });
    });

    it('never hands a message to AGY if its durable dispatch state is unconfirmed', async () => {
        const f = await fixture();
        await f.call();
        f.client.setSteerDeliveryState.mockResolvedValueOnce(false);
        f.queue.push('not sent', MODE, 'persist-failed');
        expect(await f.steer('persist-failed')).toMatchObject({ steered: false, error: 'AGY steer state is unconfirmed' });
        expect(await f.call()).toEqual({});
        expect(f.client.emitSteerIndeterminate).toHaveBeenCalledExactlyOnceWith(['persist-failed']);
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(f.queue.size()).toBe(0);
    });

    it('holds a recovery interrupted by session shutdown after its queued ACK', async () => {
        const f = await fixture();
        await f.call();
        f.queue.push('shutdown while restoring', MODE, 'race');
        expect(await f.steer('race')).toEqual({ steered: false, pending: true });
        let release!: (value: boolean) => void;
        f.client.setSteerDeliveryState.mockImplementationOnce(() => new Promise<boolean>(done => { release = done; }));
        const ending = f.steering.finishTurn();
        await vi.waitFor(() => expect(release).toBeDefined());
        f.steering.stopAccepting(true);
        release(true);
        await ending;
        expect(f.queue.size()).toBe(0);
        expect(f.client.emitSteerIndeterminate).toHaveBeenCalledExactlyOnceWith(['race']);
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });
});
