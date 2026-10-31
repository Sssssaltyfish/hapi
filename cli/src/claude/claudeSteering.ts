import { randomUUID } from 'node:crypto';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { QueueReservation } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';
import type { Session } from './session';
import type { SDKMessage } from './sdk';
import { ClaudeInputUnavailableError } from './sdk/types';

export interface ClaudeInputLease {
    uuid: string;
    version: string;
    send(text: string, uuid: string): Promise<void>;
}

// Conservative floor: the shipped CLI and its UUID receipts were verified together.
export function supportsClaudeSteering(version: string): boolean {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 309)));
}

type Pending = { taken: QueueReservation<EnhancedMode>; lease: ClaudeInputLease; accepted: boolean };

/** Owns reservations in the existing queue, never another message drainer. */
export class ClaudeSteering {
    private lease: ClaudeInputLease | null = null;
    private modeHash: string | null = null;
    private pending = new Map<string, Pending>();
    private waiters = new Set<() => void>();
    private unregister: () => void;

    constructor(private readonly session: Session) {
        this.unregister = session.registerQueuedSteerHandler(id => this.steer(id), id => this.isPending(id));
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async (raw: unknown) => {
            const id = (raw as { localId?: unknown } | null)?.localId;
            return typeof id === 'string' ? this.steer(id) : { steered: false, error: 'Missing localId' };
        });
        this.reset();
    }

    setLease(lease: ClaudeInputLease | null, modeHash: string | null): void {
        this.lease = lease && supportsClaudeSteering(lease.version) ? lease : null;
        this.modeHash = modeHash;
        if (lease) this.session.client.updateMetadata(metadata => ({ ...metadata,
            capabilities: { ...metadata.capabilities, steering: this.lease !== null } }));
        this.session.client.updateAgentState(state => ({ ...state, steeringActive: this.lease !== null }));
    }

    isPending(id: string): boolean {
        return [...this.pending.values()].some(entry => !entry.accepted && entry.taken.item.localId === id);
    }

    hasPending(): boolean { return this.pending.size > 0; }

    private signal(): void { for (const waiter of this.waiters) waiter(); }

    async waitForPending(signal?: AbortSignal): Promise<void> {
        while (this.pending.size && !signal?.aborted) await new Promise<void>(resolve => {
            const done = () => { this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
            this.waiters.add(done);
            signal?.addEventListener('abort', done, { once: true });
            if (signal?.aborted || !this.pending.size) done();
        });
    }

    async steer(id: string): Promise<{ steered: boolean; pending?: boolean; error?: string }> {
        const lease = this.lease;
        if (!lease) return { steered: false, error: 'No verified active Claude turn' };
        const taken = this.session.queue.takeByLocalId(id);
        if (!taken) return { steered: false, error: 'Message not in queue' };
        const text = this.session.expandSkillReference(taken.item.message);
        if (taken.item.isolate || text.trimStart().startsWith('/') || taken.item.modeHash !== this.modeHash) {
            this.session.queue.restoreReservation(taken);
            return { steered: false, error: 'Message requires a new Claude turn' };
        }
        if (!this.session.queue.beginReservationDispatch(taken)) return { steered: false, error: 'Steer cancelled' };
        const uuid = randomUUID();
        const entry: Pending = { taken, lease, accepted: false };
        const restore = async () => {
            if (!taken.originIndeterminate && await this.session.client.setSteerDeliveryState([id], 'queued')) {
                this.session.queue.restoreReservation(taken);
            } else {
                this.session.queue.markReservationIndeterminate(taken);
                this.session.client.emitSteerIndeterminate([id]);
            }
        };
        if (!await this.session.client.setSteerDeliveryState([id], 'dispatching')) {
            this.session.queue.markReservationIndeterminate(taken);
            this.session.client.emitSteerIndeterminate([id]);
            return { steered: false, error: 'Steer state is unconfirmed' };
        }
        if (this.lease !== lease || taken.state !== 'dispatching') {
            await restore();
            return { steered: false, error: 'Active Claude turn changed' };
        }
        this.pending.set(uuid, entry);
        this.session.client.notePendingHubPromptEcho(text, [id]);
        try {
            await lease.send(text, uuid);
            return entry.accepted ? { steered: true } : { steered: false, pending: true };
        } catch (error) {
            if (this.lease === lease) this.setLease(null, null);
            if (entry.accepted) return { steered: true };
            if (error instanceof ClaudeInputUnavailableError) {
                this.pending.delete(uuid); this.signal();
                this.session.client.discardPendingHubPromptEcho(id);
                await restore();
            } else {
                this.session.queue.markReservationIndeterminate(taken);
                this.session.client.emitSteerIndeterminate([id]);
            }
            return { steered: false, error: 'Claude input was not confirmed; inspect the queue before retrying' };
        }
    }

    observe(message: SDKMessage): void {
        const ids = new Set(Array.isArray(message.user_message_uuids)
            ? message.user_message_uuids.filter((id): id is string => typeof id === 'string') : []);
        if (typeof message.user_message_uuid === 'string') ids.add(message.user_message_uuid);
        if (!['assistant', 'result', 'stream_event'].includes(message.type)) return;
        for (const [uuid, entry] of this.pending) {
            const id = entry.taken.item.localId!;
            if (ids.has(uuid)) {
                if (!entry.accepted) {
                    entry.accepted = true;
                    this.session.queue.commitReservation(entry.taken);
                    this.session.client.emitMessagesConsumed([id], { steered: ids.has(entry.lease.uuid) });
                }
            } else if (message.type === 'result' && !entry.accepted && entry.taken.state === 'dispatching') {
                this.session.queue.markReservationIndeterminate(entry.taken);
                this.session.client.emitSteerIndeterminate([id]);
            }
            // An assistant receipt can precede its result. Keep ordinary HAPI
            // queue input behind that turn so its ACK/order does not race it.
            if (message.type === 'result' && ids.has(uuid) && entry.accepted) this.pending.delete(uuid);
        }
        this.signal();
    }

    reset(): void {
        this.setLease(null, null);
        this.session.client.updateMetadata(metadata => ({ ...metadata, capabilities: { ...metadata.capabilities, steering: false } }));
        for (const { taken } of this.pending.values()) {
            if (this.session.queue.markReservationIndeterminate(taken)) this.session.client.emitSteerIndeterminate([taken.item.localId!]);
        }
        this.pending.clear(); this.signal();
    }

    close(): void {
        this.reset(); this.unregister();
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async () => ({ steered: false, error: 'Claude session ending' }));
    }
}
