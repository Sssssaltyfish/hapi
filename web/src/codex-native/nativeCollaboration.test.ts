import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { getCodexAgentFieldRows } from '@/components/ToolCard/codexAgents'
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

function tools(entries: NativeItemEntry[]): ToolCallBlock[] {
    const projected = projectNativeItems(entries, [])
    const normalized = projected.messages.map(normalizeDecryptedMessage)
        .filter((message): message is NormalizedMessage => message !== null)
    return reduceChatBlocks(normalized, { requests: projected.requests }).blocks
        .filter((block): block is ToolCallBlock => block.kind === 'tool-call')
}

it('projects actual desktop subAgentActivity records into the existing agent card with real identity', () => {
    const cards = tools([activity('spawn', 'started', 100, 'gpt-6.1-sol'), activity('send', 'interacted', 200)])
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe(`codex-agent:${agentId}`)
    expect(cards[0].tool.name).toBe('CodexAgent')
    // completedAtMs belongs to each activity record; the run is still active.
    expect(cards[0].tool.state).toBe('running')
    expect(getCodexAgentFieldRows('CodexAgent', cards[0].tool.input)).toEqual(expect.arrayContaining([
        { label: 'Agent', value: agentId },
        { label: 'Work', value: '/root/native_subagents' },
        { label: 'Model', value: 'gpt-6.1-sol' },
        { label: 'Reasoning', value: 'high' },
    ]))
})

it('keeps completed child state through interactions and allows an explicit new start', () => {
    const entries = [activity('spawn', 'started', 100), activity('done', 'completed', 200), activity('send', 'interacted', 300)]
    expect(tools(entries)[0].tool.state).toBe('completed')
    expect(tools([...entries, activity('restart', 'started', 400)])[0].tool.state).toBe('running')
})

it('renders a completed activity from a history window without requiring its spawn record', () => {
    const cards = tools([activity('done', 'completed', 200)])
    expect(cards).toHaveLength(1)
    expect(cards[0].tool.state).toBe('completed')
    expect(cards[0].tool.input).toMatchObject({ agentId, summary: '/root/native_subagents' })
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
