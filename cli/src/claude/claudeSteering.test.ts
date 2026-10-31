import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { ClaudeSteering, supportsClaudeSteering, type ClaudeInputLease } from './claudeSteering';
import { ClaudeInputUnavailableError } from './sdk/types';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

function fixture() {
    const mode: EnhancedMode = { permissionMode: 'default' };
    const queue = new MessageQueue2<EnhancedMode>(JSON.stringify);
    let metadata: any = { capabilities: {} };
    let state: any = {};
    const client = {
        updateMetadata: (fn: (value: any) => any) => { metadata = fn(metadata); },
        updateAgentState: (fn: (value: any) => any) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: vi.fn() },
        setSteerDeliveryState: vi.fn(async () => true),
        emitMessagesConsumed: vi.fn(), emitSteerIndeterminate: vi.fn(),
        notePendingHubPromptEcho: vi.fn(), discardPendingHubPromptEcho: vi.fn(),
    };
    const expand = vi.fn((text: string) => text);
    const session = { queue, client, expandSkillReference: expand,
        registerQueuedSteerHandler: () => () => {} } as unknown as Session;
    const steering = new ClaudeSteering(session);
    const send = vi.fn(async (_text: string, _uuid: string) => {});
    const lease: ClaudeInputLease = { uuid: 'baseline', version: '2.1.309', send };
    steering.setLease(lease, queue.modeHasher(mode));
    queue.push('adjust the active task', mode, 'local');
    return { queue, client, steering, send, lease, mode, expand, metadata: () => metadata, state: () => state };
}

describe('Claude soft input reservations', () => {
    it('gates unknown/older runtimes and confirms a same-turn UUID once', async () => {
        expect(supportsClaudeSteering('2.1.308')).toBe(false);
        expect(supportsClaudeSteering('unknown')).toBe(false);
        const f = fixture();
        f.steering.setLease({ ...f.lease, version: '2.1.308' }, f.queue.modeHasher(f.mode));
        expect(f.state().steeringActive).toBe(false);
        expect(await f.steering.steer('local')).toMatchObject({ steered: false });
        f.steering.setLease(f.lease, f.queue.modeHasher(f.mode));
        expect(f.metadata().capabilities.steering).toBe(true);
        const sent = f.steering.steer('local');
        expect(f.queue.cancelByLocalId('local')).toBe('in-flight');
        expect(await sent).toEqual({ steered: false, pending: true });
        const uuid = f.send.mock.calls[0][1];
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        f.steering.observe({ type: 'assistant', user_message_uuids: ['baseline', uuid] });
        expect(f.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['local'], { steered: true, invokedAt: expect.any(Number) });
        let drained = false;
        const waiting = f.steering.waitForPending().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        f.steering.observe({ type: 'result', user_message_uuids: ['another-turn'] });
        await Promise.resolve();
        expect(drained).toBe(false);
        f.steering.observe({ type: 'result', user_message_uuids: ['baseline', uuid] });
        await waiting;
        expect(f.client.emitMessagesConsumed).toHaveBeenCalledTimes(1);
        f.steering.close();
    });

    it('restores rather than steering a replacement generation after persistence', async () => {
        const f = fixture();
        let release!: (saved: boolean) => void;
        f.client.setSteerDeliveryState.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const sent = f.steering.steer('local');
        f.steering.setLease({ ...f.lease, uuid: 'replacement' }, f.queue.modeHasher(f.mode));
        release(true);
        expect(await sent).toMatchObject({ steered: false, error: 'Active Claude turn changed' });
        expect(f.send).not.toHaveBeenCalled();
        expect(f.queue.peekByLocalId('local')?.message).toBe('adjust the active task');
        f.steering.setLease(f.lease, 'different-mode');
        expect(await f.steering.steer('local')).toMatchObject({ steered: false });
        expect(f.queue.peekByLocalId('local')).not.toBeNull();
        f.steering.setLease(f.lease, f.queue.modeHasher(f.mode));
        f.queue.push('/plugin command', f.mode, 'command');
        expect(await f.steering.steer('command')).toMatchObject({ steered: false });
        expect(f.queue.peekByLocalId('command')?.message).toBe('/plugin command');
        f.expand.mockReturnValue('/native skill');
        f.queue.push('$native skill', f.mode, 'skill');
        expect(await f.steering.steer('skill')).toMatchObject({ steered: false });
        expect(f.queue.peekByLocalId('skill')?.message).toBe('$native skill');
        expect(f.send).not.toHaveBeenCalled();
        f.steering.close();
    });

    it('restores definite pre-write failures but holds ambiguous writes', async () => {
        const f = fixture();
        f.send.mockRejectedValueOnce(new ClaudeInputUnavailableError('closed before write'));
        expect(await f.steering.steer('local')).toMatchObject({ steered: false });
        expect(f.queue.peekByLocalId('local')).not.toBeNull();
        expect(f.state().steeringActive).toBe(false);
        f.steering.setLease(f.lease, f.queue.modeHasher(f.mode));
        f.send.mockRejectedValueOnce(new Error('pipe broke during write'));
        expect(await f.steering.steer('local')).toMatchObject({ steered: false });
        expect(f.queue.peekByLocalId('local')).toBeNull();
        expect(f.steering.isPending('local')).toBe(true);
        expect(f.client.emitSteerIndeterminate).toHaveBeenCalledWith(['local']);
        f.steering.reset();
        expect(f.steering.isPending('local')).toBe(false);
        expect(f.queue.releaseIndeterminateReservation('local')).toBe(true);
        f.steering.close();
    });

    it('holds unconfirmed native input across the first result and acknowledges later consumption without a steer claim', async () => {
        const f = fixture();
        await f.steering.steer('local');
        const uuid = f.send.mock.calls[0][1];
        let drained = false;
        const waiting = f.steering.waitForPending().then(() => { drained = true; });
        f.steering.observe({ type: 'result', user_message_uuids: ['baseline'] });
        expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(f.queue.peekByLocalId('local')).toBeNull();
        f.steering.observe({ type: 'assistant', user_message_uuids: [uuid] });
        expect(f.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['local'], { steered: false, invokedAt: expect.any(Number) });
        await Promise.resolve();
        expect(drained).toBe(false);
        f.steering.observe({ type: 'result', user_message_uuids: [uuid] });
        await waiting;
        expect(f.send).toHaveBeenCalledTimes(1);
        f.steering.close();
    });

    it.each([true, false])('orders input before its answer when UUID confirmation arrives only in the result (same turn: %s)', async (sameTurn) => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
        const f = fixture();
        try {
            await f.steering.steer('local');
            const uuid = f.send.mock.calls[0][1];
            if (!sameTurn) {
                clock.mockReturnValue(200);
                f.steering.observe({ type: 'assistant' });
                clock.mockReturnValue(300);
                f.steering.observe({ type: 'result', user_message_uuids: ['baseline'] });
            }
            clock.mockReturnValue(400);
            f.steering.observe({ type: 'assistant' });
            expect(f.client.emitMessagesConsumed).not.toHaveBeenCalled();
            clock.mockReturnValue(500);
            f.steering.observe({ type: 'result', user_message_uuids: sameTurn ? ['baseline', uuid] : [uuid] });
            expect(f.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['local'], {
                steered: sameTurn,
                // Equal assistant timestamps sort after the earlier queued row's seq.
                invokedAt: sameTurn ? 100 : 400,
            });
        } finally {
            f.steering.close();
            clock.mockRestore();
        }
    });
});
