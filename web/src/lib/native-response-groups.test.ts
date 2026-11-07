import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks, getToolGroupEntries, isToolGroupBlock, type ToolGroupBlock } from '@/chat/toolGroups'
import type { NormalizedMessage } from '@/chat/types'
import { projectNativeItems } from '@/codex-native/projectNativeItems'
import type { NativeItemEntry } from '@/codex-native/types'
import { buildMaterializedTimelineRows } from './assistant-runtime'
import { StableChatTimeline } from './stable-chat-timeline'

const entries: NativeItemEntry[] = [
    { turnId: 'turn', startedAtMs: 10, completedAtMs: 11, item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Checking the change' } },
    { turnId: 'turn', startedAtMs: 20, completedAtMs: 21, item: { id: 'reasoning', type: 'reasoning', summary: ['Reviewing the result'] } },
    { turnId: 'turn', startedAtMs: 25, item: { id: 'opaque', type: 'reasoning', summary: [], content: ['opaque content'] } },
    { turnId: 'turn', startedAtMs: 30, completedAtMs: 31, item: { id: 'activity', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child', agentPath: '/root/reviewer' } },
    { turnId: 'turn', startedAtMs: 35, completedAtMs: 36, item: { id: 'update', type: 'agentMessage', phase: 'commentary', text: 'The checks passed' } },
    { turnId: 'turn', startedAtMs: 40, completedAtMs: 41, item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'The change is ready' } },
]

function materialize(items = entries, previousGroups?: ToolGroupBlock[], hasMoreMessages = false) {
    const projected = projectNativeItems(items, [])
    const normalized = projected.messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
    return buildMaterializedTimelineRows(buildVisibleChatBlocks(
        reduceChatBlocks(normalized, { requests: projected.requests }).blocks,
        { hasMoreMessages, previousGroups },
    ))
}

it('keeps folded reasoning and activity within commentary while preserving each source and the final response', () => {
    const reasoning = { ...entries[1], item: { ...entries[1].item, summary: ['Reviewing the result', 'Checking the output'] } }
    const rows = materialize([entries[0], reasoning, ...entries.slice(2)])
    expect(rows.map(row => row.role)).toEqual(['assistant', 'assistant'])
    expect(rows[0].sourceIds).toEqual(expect.arrayContaining(['native:commentary', 'native:reasoning', 'native:activity', 'native:update']))
    expect(rows[0].sourceIds).not.toContain('native:opaque')
    const commentary = rows[0].project('commentary', rows[0].blocks)
    expect(commentary.metadata?.custom?.turnCount).toBeUndefined()
    expect(commentary.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Checking the change' }),
        expect.objectContaining({ type: 'tool-call', toolName: 'ToolGroup' }),
    ]))
    const activityGroup = rows[0].blocks.find(isToolGroupBlock)!
    expect(activityGroup).toMatchObject({ defaultOpen: false, summary: { totalTools: 0 } })
    expect(getToolGroupEntries(activityGroup)).toMatchObject([
        { kind: 'agent-reasoning', id: 'native:reasoning', text: 'Reviewing the result' },
        { kind: 'agent-reasoning', id: 'native:reasoning:summary:1', text: 'Checking the output' },
        { kind: 'agent-event', id: 'native:activity', event: { type: 'agent-activity' } },
    ])
    expect(rows[1].project('final', rows[1].blocks).content).toEqual([expect.objectContaining({ type: 'text', text: 'The change is ready' })])
})

it('keeps the reasoning source as the live window grows into a group and trims its first member', () => {
    const timeline = new StableChatTimeline()
    const initial = timeline.update(materialize(entries.slice(0, 3)))
    const original = initial[0]
    expect(original.message.content).toEqual(expect.arrayContaining([expect.objectContaining({
        type: 'tool-call', toolName: 'HapiNativeReasoning',
        artifact: expect.objectContaining({ kind: 'agent-reasoning', id: 'native:reasoning' }),
    })]))
    const fullRows = materialize()
    const appended = timeline.update(fullRows)
    expect(appended[0].message.id).toBe(original.message.id)
    const ids = appended.map(row => row.message.id)
    const previousGroups = fullRows.flatMap(row => row.blocks.filter(isToolGroupBlock))
    const trimmed = timeline.update(materialize(entries.slice(3), previousGroups, true))
    expect(trimmed.map(row => row.message.id)).toEqual(ids)
    expect(JSON.stringify(trimmed[0].message.content).match(/Reviewing the result/g)).toHaveLength(1)
    expect(timeline.update(materialize()).map(row => row.message.id)).toEqual(ids)
    expect(timeline.resolveRowId('native:commentary')).toBe(ids[0])
    expect(timeline.resolveRowId('agent-reasoning:native:reasoning')).toBe(ids[0])
    expect(timeline.resolveRowId('native:activity')).toBe(ids[0])
    expect(timeline.resolveRowId('native:final')).toBe(ids[1])
    expect(JSON.stringify(appended[0].message.content).match(/"sourceItemId":"activity"/g)).toHaveLength(1)
})

it('keeps an unknown-phase response identity when the provider later classifies it as final', () => {
    const timeline = new StableChatTimeline()
    const unknownFinal = { ...entries[5], item: { ...entries[5].item, phase: null } }
    const initial = timeline.update(materialize([...entries.slice(0, 5), unknownFinal]))
    const finalId = initial[1].message.id
    const complete = timeline.update(materialize())
    expect(complete).toHaveLength(2)
    expect(complete[1].message.id).toBe(finalId)
    expect(complete.filter(row => JSON.stringify(row.message.content).includes('The change is ready'))).toHaveLength(1)
})
