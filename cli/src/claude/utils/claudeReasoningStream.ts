import type { AgentMessage } from '@/agent/types';
import { isObject } from '@hapi/protocol';
import type { SDKMessage } from '../sdk';

const SNAPSHOT_INTERVAL_MS = 250;

interface ThinkingBlock {
    id: string;
    index: number;
    text: string;
    lastSnapshotAt?: number;
}

function hasThinkingText(block: unknown): block is { thinking: string } {
    return isObject(block) && block.type === 'thinking'
        && typeof block.thinking === 'string' && block.thinking.trim().length > 0;
}

export class ClaudeReasoningStream {
    private messageId?: string;
    private thinking?: ThinkingBlock;

    constructor(private readonly emit: (message: Extract<AgentMessage, { type: 'reasoning' }>) => void) {}

    /** Returns the position of a final assistant block already represented by a reasoning stream. */
    observe(message: SDKMessage): number | undefined {
        if (message.parent_tool_use_id != null) return;
        if (message.type === 'result') this.finish();
        if (message.type === 'assistant') return this.reconcile(message.message);
        if (message.type !== 'stream_event' || !isObject(message.event)) return;

        const event = message.event;
        if (event.type === 'message_start') {
            this.finish();
            if (isObject(event.message) && typeof event.message.id === 'string') {
                this.messageId = event.message.id;
            }
        } else if (event.type === 'content_block_start') {
            this.finishBlock();
            const block = event.content_block;
            if (this.messageId && typeof event.index === 'number' && isObject(block) && block.type === 'thinking') {
                this.thinking = {
                    id: `claude-${this.messageId}-thinking-${event.index}`,
                    index: event.index,
                    text: ''
                };
                if (typeof block.thinking === 'string') this.append(block.thinking);
            }
        } else if (event.type === 'content_block_delta' && this.thinking?.index === event.index) {
            const delta = event.delta;
            if (isObject(delta) && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                this.append(delta.thinking);
            }
        } else if (event.type === 'message_stop') {
            this.finish();
        }
        return undefined;
    }

    finish(): void {
        this.finishBlock();
        this.messageId = undefined;
    }

    private append(text: string): void {
        const block = this.thinking;
        if (!block || !text) return;
        block.text += text;
        const now = Date.now();
        if (block.lastSnapshotAt !== undefined && now - block.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
        if (!block.text.trim()) return;
        block.lastSnapshotAt = now;
        this.emit({ type: 'reasoning', id: block.id, text: block.text, live: true });
    }

    private reconcile(message: unknown): number | undefined {
        const block = this.thinking;
        if (!block || !isObject(message) || message.id !== this.messageId || !Array.isArray(message.content)) return;

        // Claude Code normally sends a complete assistant message for the active
        // block before its stop event, in a content array containing just that block.
        const index = message.content.length === 1 ? 0 : block.index;
        const final = message.content[index];
        if (!hasThinkingText(final)) return;
        this.thinking = undefined;
        if (block.lastSnapshotAt === undefined) return;
        this.emit({ type: 'reasoning', id: block.id, text: final.thinking });
        return index;
    }

    private finishBlock(): void {
        const block = this.thinking;
        this.thinking = undefined;
        if (block?.lastSnapshotAt !== undefined) {
            this.emit({ type: 'reasoning', id: block.id, text: block.text });
        }
    }
}
