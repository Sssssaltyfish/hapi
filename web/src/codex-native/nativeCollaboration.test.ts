import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { getEventPresentation } from '@/chat/presentation'
import { projectNativeItems } from './projectNativeItems'
import type { NativeItemEntry } from './types'

const agentId = '01a19196-83b0-7273-b6da-ff5b2b070160'
const activity = (id: string, kind: string, at: number, model?: string): NativeItemEntry => ({
    turnId: 'native-turn', startedAtMs: at, completedAtMs: at,
    item: {
        id, type: 'subAgentActivity', kind,
        agentThreadId: agentId, agentPath: '/root/native_subagents',
        model: model ?? null, reasoningEffort: model ? 'high' : null,
    },
})

function blocks(entries: NativeItemEntry[]): ChatBlock[] {
    const projected = projectNativeItems(entries, [])
    const normalized = projected.messages.map(normalizeDecryptedMessage)
        .filter((message): message is NormalizedMessage => message !== null)
    return reduceChatBlocks(normalized, { requests: projected.requests }).blocks
}

function tools(entries: NativeItemEntry[]): ToolCallBlock[] {
    return blocks(entries).filter((block): block is ToolCallBlock => block.kind === 'tool-call')
}

it('projects each desktop activity with its own source identity and recorded details', () => {
    const events = blocks([activity('spawn', 'started', 100, 'gpt-6.1-sol'), activity('send', 'interacted', 200)])
    expect(events.map(block => block.id)).toEqual(['native:spawn', 'native:send'])
    expect(events[0]).toMatchObject({ kind: 'agent-event', event: {
        type: 'agent-activity', sourceItemId: 'spawn', agentId,
        activityKind: 'started', summary: '/root/native_subagents',
        agentPath: '/root/native_subagents', model: 'gpt-6.1-sol', reasoningEffort: 'high',
    } })
    expect(events[1]).toMatchObject({ kind: 'agent-event', event: { activityKind: 'interacted' } })
    expect(events.every(block => block.kind === 'agent-event' && !('status' in block.event))).toBe(true)
})

it('preserves retained activity order and meaning through prepend, trim and rehydration', () => {
    const entries: NativeItemEntry[] = [
        activity('spawn', 'started', 100),
        { startedAtMs: 150, item: { id: 'user', type: 'userMessage', content: [{ text: 'Next request' }] } },
        activity('done', 'completed', 200),
        { startedAtMs: 250, item: { id: 'reply', type: 'agentMessage', text: 'Response' } },
        activity('send', 'interacted', 300),
        activity('send-again', 'interacted', 350),
        activity('restart', 'started', 400),
    ]
    const complete = blocks(entries)
    expect(complete.map(block => block.id)).toEqual([
        'native:spawn', 'native:user', 'native:done', 'native:reply', 'native:send', 'native:send-again', 'native:restart',
    ])
    for (const window of [entries.slice(2), entries.slice(4), entries.slice(1), entries]) {
        const retained = blocks(window)
        expect(retained).toEqual(complete.filter(block => window.some(entry => `native:${entry.item.id}` === block.id)))
    }
    const labels = complete.flatMap(block => block.kind === 'agent-event' ? [getEventPresentation(block.event).text] : [])
    expect(labels).toEqual([
        'Started /root/native_subagents', 'Completed /root/native_subagents',
        'Interacted with /root/native_subagents', 'Interacted with /root/native_subagents', 'Started /root/native_subagents',
    ])
    expect(labels.some(label => /running/i.test(label))).toBe(false)
})

it('renders completed, failed and unknown activity as recorded events without a child lifecycle', () => {
    const events = blocks([activity('done', 'completed', 200), activity('fail', 'errored', 250), activity('update', 'updated', 300)])
    expect(events.every(block => block.kind === 'agent-event')).toBe(true)
    expect(events.flatMap(block => block.kind === 'agent-event' ? [getEventPresentation(block.event).text] : [])).toEqual([
        'Completed /root/native_subagents', 'Failed /root/native_subagents', 'Activity (updated) for /root/native_subagents',
    ])
})

it('maps collab lifecycle items to the runner tool cards', () => {
    const cards = tools([
        { startedAtMs: 100, completedAtMs: 120, item: {
            id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
            prompt: 'Review the change', receiverThreadIds: [agentId], agentsStates: { [agentId]: { status: 'running' } },
        } },
        { startedAtMs: 200, completedAtMs: 220, item: {
            id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
            receiverThreadIds: [agentId], agentsStates: { [agentId]: { status: 'completed', message: 'Done' } },
        } },
    ])
    expect(cards.map(card => card.tool.name)).toEqual(['spawn_agent', 'wait_agent'])
    expect(cards[0].tool.result).toMatchObject({ agent_id: agentId })
    expect(cards[1].tool.result).toMatchObject({ status: { [agentId]: { status: 'completed', message: 'Done' } } })
})

it('marks a failed native collaboration tool as an error in the existing card', () => {
    const cards = tools([{ startedAtMs: 100, completedAtMs: 120, item: {
        id: 'failed-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'failed', error: 'Agent limit reached',
    } }])
    expect(cards[0].tool.state).toBe('error')
})
