import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { shellJoin } from '@/modules/common/shellQuote';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { QueueReservation } from '@/utils/MessageQueue2';
import type { AgyMode } from '../types';
import type { AgySession } from '../session';

export type AgySteerResult = { steered: boolean; pending?: boolean; error?: string };
type Turn = { generation: string; modeHash: string; conversationId: string | null; verified: boolean; closing: boolean };
type Pending = {
    taken: QueueReservation<AgyMode>;
    turn: Turn;
    ready: boolean;
    preparing?: Promise<boolean>;
    restoring?: Promise<void>;
    receipt?: { path: string; conversationId: string; cursor: number; buffer: string; minStep: number; bytes: number; decoder: StringDecoder };
    resolve: (result: AgySteerResult) => void;
};
type HookPayload = {
    conversationId: string;
    invocationNum: number;
    initialNumSteps: number;
    workspacePaths: string[];
    transcriptPath: string;
    artifactDirectoryPath: string;
};

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reservations stay in MessageQueue2's ownership; this is only a hook lease. */
export class AgySteering {
    private server: Server | null = null;
    private overlay: string | null = null;
    private port = 0;
    private token = randomBytes(24).toString('hex');
    private turn: Turn | null = null;
    private pending = new Map<string, Pending>();
    private receiptSteps = new Set<number>();
    private checking: Promise<void> = Promise.resolve();
    private unregister: () => void;
    private ending = false;

    constructor(private readonly session: AgySession) {
        this.unregister = session.registerQueuedSteerHandler(id => this.steer(id), id => this.pending.has(id));
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async (raw: unknown) => {
            const id = (raw as { localId?: unknown } | null)?.localId;
            return typeof id === 'string' ? this.steer(id) : { steered: false, error: 'Missing localId' };
        });
        session.client.updateMetadata(metadata => ({ ...metadata, capabilities: { ...metadata.capabilities, steering: false } }));
        this.publishActive(false);
    }

    private publishActive(active: boolean): void {
        this.session.client.updateAgentState?.(state => ({ ...state, steeringActive: active }));
    }

    async start(): Promise<void> {
        this.overlay = await mkdtemp(join(tmpdir(), 'hapi-agy-hooks-'));
        await mkdir(join(this.overlay, '.agents'), { mode: 0o700 });
        const command = (event: 'pre' | 'post') => {
            const cli = getHappyCliCommand(['agy-hook', event]);
            return { type: 'command', command: shellJoin([cli.command, ...cli.args]), timeout: 10 };
        };
        await writeFile(join(this.overlay, '.agents', 'hooks.json'), JSON.stringify({ 'hapi-session-steering': {
            PreInvocation: [command('pre')], PostInvocation: [command('post')],
        } }), { mode: 0o600 });
        const server = createServer(async (req, res) => {
            if (req.method !== 'POST' || !['/agy-hook/pre', '/agy-hook/post'].includes(req.url ?? '')
                || req.headers['x-hapi-hook-token'] !== this.token) {
                res.writeHead(403).end('{}'); req.resume(); return;
            }
            const timeout = setTimeout(() => req.destroy(), 3000);
            try {
                const chunks: Buffer[] = [];
                let bytes = 0;
                for await (const chunk of req) {
                    bytes += chunk.length;
                    if (bytes > 512 * 1024) throw new Error('Hook payload too large');
                    chunks.push(Buffer.from(chunk));
                }
                const result = await this.handleHook(req.url!.endsWith('/post') ? 'post' : 'pre',
                    req.headers['x-hapi-hook-generation'], JSON.parse(Buffer.concat(chunks).toString('utf8')));
                if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
            } catch {
                if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
            } finally { clearTimeout(timeout); }
        });
        await new Promise<void>((done, fail) => {
            server.once('error', fail);
            server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); done(); });
        });
        this.server = server;
        this.port = (server.address() as { port: number }).port;
    }

    beginTurn(modeHash: string, conversationId: string | null): { addDirectory?: string; env: NodeJS.ProcessEnv } {
        const generation = randomUUID();
        this.turn = { generation, modeHash, conversationId, verified: false, closing: false };
        this.receiptSteps.clear();
        this.publishActive(false);
        return { addDirectory: this.overlay ?? undefined, env: {
            HAPI_AGY_HOOK_PORT: String(this.port), HAPI_AGY_HOOK_TOKEN: this.token, HAPI_AGY_HOOK_GENERATION: generation,
        } };
    }

    adoptConversation(id: string): void {
        if (!this.turn) return;
        if (this.turn.verified && this.turn.conversationId !== id) this.stopAccepting();
        this.turn.conversationId = id;
    }

    cancel(id: string): boolean | 'in-flight' | 'indeterminate' | 'consumed' {
        const entry = this.pending.get(id);
        if (!entry) return false;
        const result = this.session.queue.cancelByLocalId(id);
        if (result === true) {
            this.pending.delete(id);
            entry.resolve({ steered: false, error: 'Steer cancelled' });
        }
        return result;
    }

    private async steer(id: string): Promise<AgySteerResult> {
        const turn = this.turn;
        if (this.pending.has(id)) return { steered: false, pending: true };
        if (!turn?.verified || turn.closing || this.ending) return { steered: false, error: 'No active verified AGY hook' };
        const taken = this.session.queue.takeByLocalId(id);
        if (!taken) return { steered: false, error: 'Message not in queue' };
        if (taken.originIndeterminate) {
            this.session.queue.restoreReservation(taken);
            return { steered: false, error: 'Earlier AGY injection is unconfirmed; cancel or edit before resending' };
        }
        if (taken.item.isolate || taken.item.modeHash !== turn.modeHash || taken.item.message.trimStart().startsWith('/')
            || Buffer.byteLength(taken.item.message) > 512 * 1024) {
            this.session.queue.restoreReservation(taken);
            return { steered: false, error: 'Message requires a new AGY turn' };
        }
        let settle!: (result: AgySteerResult) => void;
        const result = new Promise<AgySteerResult>(done => { settle = done; });
        const entry: Pending = { taken, turn, ready: false, resolve: settle };
        this.pending.set(id, entry);
        entry.preparing = this.session.client.setSteerDeliveryState([id], 'dispatching').catch(() => false);
        const persisted = await entry.preparing;
        if (this.pending.get(id) !== entry) return result;
        if (taken.state === 'cancelled') {
            this.pending.delete(id); entry.resolve({ steered: false, error: 'Steer cancelled' }); return result;
        }
        if (!persisted) {
            this.hold(id, entry, 'AGY steer state is unconfirmed');
        } else if (this.turn !== turn || turn.closing || this.ending) {
            await this.restore(id, entry);
        } else {
            entry.ready = true;
            return { steered: false, pending: true };
        }
        return result;
    }

    private validPayload(raw: unknown, turn: Turn): raw is HookPayload {
        const data = raw as Partial<HookPayload> | null;
        if (!data || !UUID.test(data.conversationId ?? '') || !Number.isInteger(data.invocationNum) || data.invocationNum! < 0
            || !Number.isInteger(data.initialNumSteps) || data.initialNumSteps! < 0
            || !Array.isArray(data.workspacePaths) || !data.workspacePaths.every(path => typeof path === 'string')
            || !data.workspacePaths.some(path => resolve(path) === resolve(this.session.path))
            || typeof data.transcriptPath !== 'string' || typeof data.artifactDirectoryPath !== 'string'
            || (turn.conversationId !== null && data.conversationId !== turn.conversationId)) return false;
        return basename(data.artifactDirectoryPath) === data.conversationId
            && ['transcript.jsonl', 'transcript_full.jsonl'].includes(basename(data.transcriptPath))
            && dirname(resolve(data.transcriptPath)) === resolve(data.artifactDirectoryPath, '.system_generated', 'logs');
    }

    async handleHook(event: 'pre' | 'post', generation: unknown, raw: unknown): Promise<Record<string, unknown>> {
        const turn = this.turn;
        if (!turn || turn.closing || this.ending || generation !== turn.generation || !this.validPayload(raw, turn)) return {};
        turn.conversationId ??= raw.conversationId;
        turn.verified = true;
        this.session.client.updateMetadata(metadata => ({ ...metadata, capabilities: { ...metadata.capabilities, steering: true } }));
        this.publishActive(true);
        await this.checkReceipts();
        if (this.turn !== turn || turn.closing || this.ending) return {};
        const item = [...this.pending.entries()].find(([, entry]) => entry.turn === turn && entry.ready && !entry.receipt);
        if (!item) return {};
        const [id, entry] = item;
        let cursor: number;
        try {
            const file = await open(raw.transcriptPath, 'r');
            try {
                const stat = await file.stat();
                cursor = stat.size;
                if (cursor) {
                    const tail = Buffer.alloc(Math.min(cursor, 128 * 1024));
                    const start = cursor - tail.length;
                    await file.read(tail, 0, tail.length, start);
                    const newline = tail.lastIndexOf(10);
                    if (newline < 0 && start > 0) return {};
                    cursor = start + newline + 1;
                }
            } finally { await file.close(); }
        } catch { return {}; }
        if (this.turn !== turn || turn.closing || this.ending || this.pending.get(id) !== entry
            || entry.taken.item.modeHash !== turn.modeHash || !this.session.queue.beginReservationDispatch(entry.taken)) return {};
        entry.receipt = { path: raw.transcriptPath, conversationId: raw.conversationId, cursor, buffer: '', minStep: raw.initialNumSteps, bytes: 0, decoder: new StringDecoder('utf8') };
        return { injectSteps: [{ userMessage: entry.taken.item.message }], ...(event === 'post' ? { terminationBehavior: 'force_continue' } : {}) };
    }

    checkReceipts(): Promise<void> {
        const check = this.checking.then(() => this.readReceipts());
        this.checking = check.catch(() => {});
        return this.checking;
    }

    private async readReceipts(): Promise<void> {
        for (const [id, entry] of this.pending) {
            const receipt = entry.receipt;
            if (!receipt || (entry.taken.state !== 'dispatching' && entry.taken.cancelReason !== 'queue-reset')) continue;
            if (entry.turn.conversationId !== receipt.conversationId) { this.hold(id, entry, 'AGY conversation changed before confirmation'); continue; }
            try {
                const file = await open(receipt.path, 'r');
                let chunk: Buffer;
                try {
                    const stat = await file.stat();
                    if (stat.size < receipt.cursor) { this.hold(id, entry, 'AGY trajectory changed before confirmation'); continue; }
                    const length = Math.min(stat.size - receipt.cursor, MAX_RECEIPT_BYTES - receipt.bytes);
                    chunk = Buffer.alloc(length);
                    const read = await file.read(chunk, 0, length, receipt.cursor);
                    chunk = chunk.subarray(0, read.bytesRead);
                    receipt.cursor += read.bytesRead;
                    receipt.bytes += read.bytesRead;
                } finally { await file.close(); }
                receipt.buffer += receipt.decoder.write(chunk);
                const lines = receipt.buffer.split('\n');
                receipt.buffer = lines.pop() ?? '';
                const prefix = `<USER_REQUEST>\n${entry.taken.item.message}\n</USER_REQUEST>`;
                for (const line of lines) {
                    let step: { source?: string; type?: string; status?: string; step_index?: number; content?: string };
                    try { step = JSON.parse(line); } catch { continue; }
                    if (step.source !== 'SYSTEM_SDK' || step.type !== 'USER_INPUT' || step.status !== 'DONE'
                        || !Number.isInteger(step.step_index) || step.step_index! < receipt.minStep
                        || typeof step.content !== 'string' || !step.content.startsWith(prefix)
                        || this.receiptSteps.has(step.step_index!)) continue;
                    this.receiptSteps.add(step.step_index!);
                    if (this.session.queue.commitReservation(entry.taken)) this.session.client.emitMessagesConsumed([id], { steered: true });
                    this.pending.delete(id);
                    entry.resolve({ steered: true });
                    break;
                }
                if (this.pending.has(id) && receipt.bytes >= MAX_RECEIPT_BYTES) this.hold(id, entry, 'AGY receipt exceeded its bounded read');
            } catch { /* Native file can settle just after its stdout step. */ }
        }
    }

    private hold(id: string, entry: Pending, error: string): void {
        if (this.pending.get(id) !== entry) return;
        if (entry.taken.state === 'reserved') this.session.queue.beginReservationDispatch(entry.taken);
        if (this.session.queue.markReservationIndeterminate(entry.taken) || entry.taken.cancelReason === 'queue-reset') this.session.client.emitSteerIndeterminate([id]);
        this.pending.delete(id);
        entry.resolve({ steered: false, error });
    }

    private async restore(id: string, entry: Pending): Promise<void> {
        return entry.restoring ??= this.restoreEntry(id, entry);
    }

    private async restoreEntry(id: string, entry: Pending): Promise<void> {
        if (this.pending.get(id) !== entry) return;
        if (entry.taken.state === 'cancelled' && !entry.receipt) {
            this.pending.delete(id); entry.resolve({ steered: false, error: 'Steer cancelled' }); return;
        }
        if (entry.receipt || this.ending) { this.hold(id, entry, 'AGY injection was not confirmed'); return; }
        let persisted = false;
        try { persisted = await this.session.client.setSteerDeliveryState([id], 'queued'); } catch { /* unconfirmed */ }
        if (this.pending.get(id) !== entry) return;
        if (entry.taken.state === 'cancelled') {
            this.pending.delete(id); entry.resolve({ steered: false, error: 'Steer cancelled' }); return;
        }
        if (!persisted) { this.hold(id, entry, 'AGY queued delivery state is unconfirmed'); return; }
        if (this.ending) { this.hold(id, entry, 'AGY session ended before queued recovery'); return; }
        try { this.session.queue.restoreReservation(entry.taken); }
        catch { this.hold(id, entry, 'AGY queue closed before recovery'); return; }
        this.pending.delete(id);
        entry.resolve({ steered: false, error: 'AGY turn ended before injection; message remains queued' });
    }

    stopAccepting(ending = false): void {
        this.ending ||= ending;
        if (this.turn) this.turn.closing = true;
        this.publishActive(false);
    }

    async finishTurn(): Promise<void> {
        this.stopAccepting();
        await Promise.all([...this.pending.values()].map(entry => entry.preparing));
        for (const delay of [0, 50, 150, 300]) {
            if (delay) await new Promise(done => setTimeout(done, delay));
            await this.checkReceipts();
            if (![...this.pending.values()].some(entry => entry.receipt)) break;
        }
        for (const [id, entry] of [...this.pending]) await this.restore(id, entry);
        this.turn = null;
    }

    async close(): Promise<void> {
        this.stopAccepting(true);
        await this.finishTurn();
        this.unregister();
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async () => ({ steered: false, error: 'AGY session ending' }));
        this.session.client.updateMetadata(metadata => ({ ...metadata, capabilities: { ...metadata.capabilities, steering: false } }));
        if (this.server) await new Promise<void>(done => { this.server!.close(() => done()); this.server!.closeAllConnections(); });
        this.server = null;
        if (this.overlay) await rm(this.overlay, { recursive: true, force: true });
        this.overlay = null;
    }
}
