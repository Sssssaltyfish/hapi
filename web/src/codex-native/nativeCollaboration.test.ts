import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { getEventPresentation } from '@/chat/presentation'
import { getCompactCodexAgentTool } from '@/components/ToolCard/codexAgents'
import { buildVisibleChatBlocks, getToolGroupEntries, isToolGroupBlock } from '@/chat/toolGroups'
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

it('shows a daemon mailbox wait as complete when its item has no result details', () => {
    const [card] = tools([{ turnId: 'native-turn', item: {
        id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
        senderThreadId: 'parent', receiverThreadIds: [], agentsStates: {},
    } }])
    expect(card.tool.result).toEqual({ status: {}, message: 'Wait completed' })
    expect(getCompactCodexAgentTool(card)).toEqual({ detail: 'Wait completed' })
})

it('groups short and detailed communication and waits while keeping short detail compact', () => {
    const message = (id: string, prompt: string): NativeItemEntry => ({
        turnId: 'turn', startedAtMs: 100, completedAtMs: 200, item: {
            id, type: 'collabAgentToolCall', tool: 'sendMessage', status: 'completed', prompt, receiverThreadIds: [agentId],
        },
    })
    const calls = tools([
        message('short', 'Keep going.'),
        message('long', 'Review this call in its original context.\nInclude the full response in the report.'),
        { turnId: 'turn', startedAtMs: 200, completedAtMs: 300, item: {
            id: 'rich-wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
            receiverThreadIds: [agentId],
            agentsStates: { [agentId]: { status: 'completed', message: 'The first check passed.\nThe second check found a problem.' } },
        } },
    ])
    expect(getCompactCodexAgentTool(calls[0])?.detail).toContain('Keep going.')
    expect(getCompactCodexAgentTool(calls[1])).toBeNull()
    expect(getCompactCodexAgentTool(calls[2])).toBeNull()
    const visible = buildVisibleChatBlocks(calls, { hasMoreMessages: false })
    expect(visible).toMatchObject([
        { kind: 'tool-group', defaultOpen: false, tools: [
            { id: 'native:short' },
            { id: 'native:long' },
            { id: 'native:rich-wait' },
        ] },
    ])
})

it('folds native activity and waits in recorded order without crossing turn or event boundaries', () => {
    const wait: NativeItemEntry = {
        turnId: 'native-turn', startedAtMs: 150, completedAtMs: 175,
        item: { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: [], agentsStates: {} },
    }
    const recorded = blocks([
        activity('send', 'interacted', 100), wait, activity('done', 'completed', 200),
        { ...activity('next', 'started', 250), turnId: 'next-turn' },
        activity('after', 'completed', 350),
    ])
    const marker: ChatBlock = { kind: 'agent-event', id: 'unrelated', createdAt: 300, event: { type: 'message', message: 'Notice' } }
    const visible = buildVisibleChatBlocks([...recorded.slice(0, 4), marker, recorded[4]], { hasMoreMessages: false })
    expect(visible.map(block => isToolGroupBlock(block) ? getToolGroupEntries(block).map(entry => entry.id) : block.id)).toEqual([
        ['native:send', 'native:wait', 'native:done'],
        'native:next',
        'unrelated',
        'native:after',
    ])
    expect(visible[0]).toMatchObject({ defaultOpen: false, summary: { totalTools: 1 } })
})
