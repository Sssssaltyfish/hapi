import type { AgentMessage } from '@/agent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeReasoningStream } from './claudeReasoningStream';

function createStream() {
    const messages: AgentMessage[] = [];
    const stream = new ClaudeReasoningStream(message => messages.push(message));
    return {
        stream,
        messages,
        event: (event: object, parent_tool_use_id: string | null = null) =>
            stream.observe({ type: 'stream_event', event, parent_tool_use_id }),
        assistant: (id: string, content: object[]) =>
            stream.observe({ type: 'assistant', parent_tool_use_id: null, message: { id, content } })
    };
}

const thinkingStart = (index: number) => ({
    type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' }
});
const thinkingDelta = (index: number, thinking: string) => ({
    type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking }
});

describe('Claude reasoning stream', () => {
    afterEach(() => vi.useRealTimers());

    it('coalesces deltas and settles the same ID using the final assistant block', () => {
        vi.useFakeTimers();
        const { messages, event, assistant } = createStream();
        event({ type: 'message_start', message: { id: 'msg_first' } });
        event(thinkingStart(2));
        event(thinkingDelta(2, 'Inspect'));
        event(thinkingDelta(2, ' the'));
        vi.advanceTimersByTime(250);
        event(thinkingDelta(2, ' output'));
        event(thinkingDelta(2, ' carefully'));

        expect(assistant('msg_first', [{ type: 'thinking', thinking: 'Inspect the output carefully.' }])).toBe(0);
        event({ type: 'content_block_stop', index: 2 });
        event({ type: 'message_stop' });

        const id = 'claude-msg_first-thinking-2';
        expect(messages).toEqual([
            { type: 'reasoning', id, text: 'Inspect', live: true },
            { type: 'reasoning', id, text: 'Inspect the output', live: true },
            { type: 'reasoning', id, text: 'Inspect the output carefully.' }
        ]);
    });

    it('leaves unmatched finals alone and isolates sidechain and non-thinking events', () => {
        const { messages, event, assistant } = createStream();
        const final = [{ type: 'thinking', thinking: 'Complete thinking' }];
        expect(assistant('msg_missing', final)).toBeUndefined();
        event({ type: 'message_start', message: { id: 'msg_main' } });
        event(thinkingStart(0));
        expect(assistant('msg_main', final)).toBeUndefined();
        event(thinkingDelta(0, 'Subagent thinking'), 'toolu_other');
        event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
        event({ type: 'message_stop' });
        expect(messages).toEqual([]);
    });

    it('settles interrupted thinking and clears correlation before the next attempt', () => {
        const { stream, messages, event, assistant } = createStream();
        event({ type: 'message_start', message: { id: 'msg_interrupted' } });
        event(thinkingStart(0));
        event(thinkingDelta(0, 'Partial'));
        stream.finish();

        expect(assistant('msg_interrupted', [{ type: 'thinking', thinking: 'An unrelated final' }])).toBeUndefined();
        expect(messages).toEqual([
            { type: 'reasoning', id: 'claude-msg_interrupted-thinking-0', text: 'Partial', live: true },
            { type: 'reasoning', id: 'claude-msg_interrupted-thinking-0', text: 'Partial' }
        ]);
    });
});
