import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import type { NormalizedMessage } from '@/chat/types'
import { projectNativeItems } from '@/codex-native/projectNativeItems'
import type { NativeItemEntry } from '@/codex-native/types'
import { buildMaterializedTimelineRows } from './assistant-runtime'
import { StableChatTimeline } from './stable-chat-timeline'
import type { WorkGroup } from './work-groups'

const entries: NativeItemEntry[] = [
    { turnId: 'turn', startedAtMs: 10, completedAtMs: 11, item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Checking the change' } },
    { turnId: 'turn', startedAtMs: 20, completedAtMs: 21, item: { id: 'activity', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child', agentPath: '/root/reviewer' } },
    { turnId: 'turn', startedAtMs: 30, completedAtMs: 31, item: { id: 'reasoning', type: 'reasoning', summary: ['Reviewing the result'] } },
    { turnId: 'turn', startedAtMs: 40, completedAtMs: 41, item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'The change is ready' } },
]

function materialize(items = entries, activeTurnId: string | null = null, requests: Parameters<typeof projectNativeItems>[1] = []) {
    const projected = projectNativeItems(items, requests, true, new Map(), { activeTurnId })
    const normalized = projected.messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
    const blocks = reduceChatBlocks(normalized, { requests: projected.requests }).blocks
    return buildMaterializedTimelineRows(buildVisibleChatBlocks(blocks, { hasMoreMessages: false }))
}

it('groups explicit work separately from the final answer, preserving every source anchor and typed activity', () => {
    const rows = materialize()
    expect(rows).toHaveLength(2)
    const work = rows[0].project('work', rows[0].blocks)
    const final = rows[1].project('final', rows[1].blocks)
    expect(work.metadata?.custom?.workGroup).toMatchObject({ turnId: 'turn', canCollapse: true, active: false })
    expect(final.metadata?.custom?.workGroup).toBeUndefined()
    expect(rows[0].sourceIds).toEqual(expect.arrayContaining(['native:commentary', 'native:activity', 'native:reasoning']))
    expect(work.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool-call', toolName: 'HapiEvent' })]))
    expect(final.content).toEqual([expect.objectContaining({ type: 'text', text: 'The change is ready' })])
})

it('keeps active, unknown-final and pending-interaction work fully visible without inventing a final answer', () => {
    const active = materialize(entries, 'turn')[0]
    expect(active.project('work', active.blocks).metadata?.custom?.workGroup).toMatchObject({ canCollapse: false, active: true })
    const unknown = materialize(entries.slice(0, 3))[0]
    expect(unknown.project('work', unknown.blocks).metadata?.custom?.workGroup).toMatchObject({ canCollapse: false, active: false })
    const pending = materialize([...entries, {
        turnId: 'turn', startedAtMs: 50, item: { id: 'approval', type: 'commandExecution', command: 'check', status: 'inProgress' },
    }], null, [{ id: 'permission', method: 'item/commandExecution/requestApproval', params: { itemId: 'approval' } }])
    expect(pending.filter(row => row.workTurnId).every(row => (row.project('work', row.blocks).metadata?.custom?.workGroup as WorkGroup | undefined)?.canCollapse === false)).toBe(true)
    expect(materialize([entries[3]])).toHaveLength(1)
    expect(materialize([entries[3]])[0].workTurnId).toBeUndefined()
})

it('shows only supplied public reasoning summaries and leaves empty summaries empty', () => {
    const rows = materialize([entries[2], {
        turnId: 'turn', startedAtMs: 35, item: { id: 'opaque-reasoning', type: 'reasoning', summary: [], content: ['opaque content'] },
    }, entries[3]])
    const work = rows[0].project('work', rows[0].blocks)
    expect(work.content).toEqual([expect.objectContaining({ type: 'reasoning', text: 'Reviewing the result' })])
    expect(rows[0].sourceIds).not.toContain('native:opaque-reasoning')
})

it('keeps work and final row identities distinct across prepend, trim and rehydration', () => {
    const timeline = new StableChatTimeline()
    const initial = timeline.update(materialize(entries.slice(2)))
    const finalId = initial[1].message.id
    const workId = initial[0].message.id
    const prepended = timeline.update(materialize())
    expect(prepended.map(row => row.message.id)).toEqual([workId, finalId])
    const trimmed = timeline.update(materialize(entries.slice(0, 2)))
    expect(trimmed.map(row => row.message.id)).toEqual([workId, finalId])
    expect(trimmed[0].message.metadata?.custom?.workGroup).toMatchObject({ canCollapse: true, finalKnown: true })
    expect(timeline.update(materialize()).map(row => row.message.id)).toEqual([workId, finalId])
})

it('updates retained work when completion arrives in a final-only materialization', () => {
    const timeline = new StableChatTimeline()
    const running = timeline.update(materialize(entries.slice(0, 3), 'turn'))
    const workId = running[0].message.id
    expect(running[0].message.metadata?.custom?.workGroup).toMatchObject({ active: true, canCollapse: false })
    const completed = timeline.update(materialize([entries[3]]))
    expect(completed[0].message.id).toBe(workId)
    expect(completed[0].message.metadata?.custom?.workGroup).toMatchObject({ active: false, canCollapse: true })
    expect(completed[1].message.metadata?.custom?.workGroup).toBeUndefined()
})

it('classifies a previously unknown message phase without duplicating its source or changing its row identity', () => {
    const timeline = new StableChatTimeline()
    const unknownFinal = { ...entries[3], item: { ...entries[3].item, phase: null } }
    const initial = timeline.update(materialize([...entries.slice(0, 3), unknownFinal], 'turn'))
    const finalId = initial[1].message.id
    expect(initial[1].message.metadata?.custom?.workGroup).toBeUndefined()
    const complete = timeline.update(materialize())
    expect(complete).toHaveLength(2)
    expect(complete[1].message.id).toBe(finalId)
    expect(complete.filter(row => JSON.stringify(row.message.content).includes('The change is ready'))).toHaveLength(1)
})
