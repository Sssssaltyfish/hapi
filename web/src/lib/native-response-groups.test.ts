import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
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

function materialize(items = entries) {
    const projected = projectNativeItems(items, [])
    const normalized = projected.messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
    return buildMaterializedTimelineRows(buildVisibleChatBlocks(reduceChatBlocks(normalized, { requests: projected.requests }).blocks, { hasMoreMessages: false }))
}

it('keeps commentary, supplied summaries, typed activity and the explicit final response visible at their own sources', () => {
    const rows = materialize()
    expect(rows.map(row => row.role)).toEqual(['assistant', 'system', 'assistant', 'assistant'])
    expect(rows[0].sourceIds).toEqual(expect.arrayContaining(['native:commentary', 'native:reasoning']))
    expect(rows[0].sourceIds).not.toContain('native:opaque')
    expect(rows[0].project('commentary', rows[0].blocks).content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Checking the change' }),
        expect.objectContaining({ type: 'reasoning', text: 'Reviewing the result' }),
    ]))
    expect(rows[1].blocks[0]).toMatchObject({ kind: 'agent-event', id: 'native:activity', event: { type: 'agent-activity' } })
    expect(rows[3].project('final', rows[3].blocks).content).toEqual([expect.objectContaining({ type: 'text', text: 'The change is ready' })])
})

it('preserves retained response content and identities when pagination discovers the final answer', () => {
    const timeline = new StableChatTimeline()
    const initial = timeline.update(materialize(entries.slice(0, 3)))
    const original = initial[0]
    const appended = timeline.update(materialize())
    expect(appended[0]).toBe(original)
    const ids = appended.map(row => row.message.id)
    expect(timeline.update(materialize(entries.slice(3))).map(row => row.message.id)).toEqual(ids)
    expect(timeline.update(materialize()).map(row => row.message.id)).toEqual(ids)
    expect(timeline.resolveRowId('native:commentary')).toBe(ids[0])
    expect(timeline.resolveRowId('native:final')).toBe(ids[3])
})

it('keeps an unknown-phase response identity when the provider later classifies it as final', () => {
    const timeline = new StableChatTimeline()
    const unknownFinal = { ...entries[5], item: { ...entries[5].item, phase: null } }
    const initial = timeline.update(materialize([...entries.slice(0, 5), unknownFinal]))
    const finalId = initial[3].message.id
    const complete = timeline.update(materialize())
    expect(complete).toHaveLength(4)
    expect(complete[3].message.id).toBe(finalId)
    expect(complete.filter(row => JSON.stringify(row.message.content).includes('The change is ready'))).toHaveLength(1)
})
