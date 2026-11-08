import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { createNativeItemProjector, projectNativeItems } from './projectNativeItems'
import type { NativeItemEntry } from './types'

it('keeps daemon reasoning parts separate and marks only the latest visible part of the active turn', () => {
    const entries: NativeItemEntry[] = [
        { turnId: 'active', item: { id: 'prior', type: 'reasoning', summary: 'One paragraph\n\nAnother paragraph', content: ['hidden'] } },
        { turnId: 'active', item: { id: 'r', type: 'reasoning', summary: ['First', '', 'Third'] } },
        { turnId: 'active', item: { id: 'cmd', type: 'commandExecution', command: 'pwd' } },
    ]
    const project = (source = entries, turnId?: string) => projectNativeItems(source, [], true, undefined, turnId).messages
        .filter(message => message.id === 'native:prior' || message.id.startsWith('native:r'))
    const live = project(entries, 'active')
    expect(live).toMatchObject([
        { id: 'native:prior', content: { content: { data: { message: 'One paragraph\n\nAnother paragraph' } },
            meta: { nativeCodexResponseItemId: 'prior', nativeReasoningSummaryIndex: 0, nativeReasoningActive: false } } },
        { id: 'native:r', content: { content: { data: { message: 'First' } },
            meta: { nativeCodexResponseItemId: 'r', nativeReasoningSummaryIndex: 0, nativeReasoningActive: false } } },
        { id: 'native:r:summary:2', content: { content: { data: { message: 'Third' } },
            meta: { nativeCodexResponseItemId: 'r', nativeReasoningSummaryIndex: 2, nativeReasoningActive: true } } },
    ])
    expect(JSON.stringify(live)).not.toContain('hidden')
    expect(project().at(-1)?.content).toMatchObject({ meta: { nativeReasoningActive: false } })
    const commentary = { turnId: 'active', item: { id: 'comment', type: 'agentMessage', text: 'Continuing', phase: 'commentary' } }
    expect(project([...entries, commentary], 'active').at(-1)?.content).toMatchObject({ meta: { nativeReasoningActive: false } })
})

it('reuses retained messages while active reasoning and async replies stay current', () => {
    const project = createNativeItemProjector()
    const tool = { item: { id: 'tool', type: 'commandExecution', status: 'completed' }, completedAtMs: 2 }
    const question = { item: { id: 'question', type: 'agentMessage', questions: [{ title: 'Continue?' }] } }
    const reasoning = { turnId: 'active', item: { id: 'r', type: 'reasoning', summary: ['Working'] } }
    const initial = project([tool, question, reasoning], [], true, undefined, 'active')
    const messages = new Map(initial.messages.map(message => [message.id, message]))
    expect(initial.requests['native-async:question']).toBeDefined()

    const nextReasoning = { turnId: 'active', item: { id: 'next', type: 'reasoning', summary: ['Checking'] } }
    const updated = project([tool, question, reasoning, nextReasoning], [], true,
        new Map([[JSON.stringify(['request_user_input_async', 'question', 0]), 'Yes']]), 'active')
    const updatedMessages = new Map(updated.messages.map(message => [message.id, message]))
    expect(updatedMessages.get('native:tool:call')).toBe(messages.get('native:tool:call'))
    expect(updatedMessages.get('native:tool:result')).toBe(messages.get('native:tool:result'))
    expect(updatedMessages.get('native:r')).not.toBe(messages.get('native:r'))
    expect(updatedMessages.get('native:r')?.content).toMatchObject({ meta: { nativeReasoningActive: false } })
    expect(updatedMessages.get('native:next')?.content).toMatchObject({ meta: { nativeReasoningActive: true } })
    expect(updatedMessages.get('native-async:question:result')).toBeDefined()
    expect(updated.requests['native-async:question']).toBeUndefined()
})

it('feeds native text, tools, timestamps and idle asynchronous questions through the existing chat pipeline', () => {
    const projected = projectNativeItems([
        { turnId: 'finished-turn', startedAtMs: 1234, completedAtMs: 1250, item: { id: 'text', type: 'agentMessage', text: '**Native response**', questions: [{ title: 'Continue?', options: ['Yes'] }] } },
        { turnId: 'finished-turn', startedAtMs: 1251, completedAtMs: 1260, item: { id: 'tool', type: 'mcpToolCall', server: 'github', tool: 'search', arguments: { query: 'test' }, result: { text: 'result' }, status: 'completed' } },
    ], [])
    const normalized = projected.messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
    const reduced = reduceChatBlocks(normalized, { requests: projected.requests })
    expect(projected.messages[0].createdAt).toBe(1234)
    expect(normalized.length).toBe(projected.messages.length)
    expect(reduced.blocks.some(block => block.kind === 'agent-text')).toBe(true)
    expect(reduced.blocks.some(block => block.kind === 'tool-call' && block.tool.name === 'mcp__github__search')).toBe(true)
    expect(projected.requests['native-async:text'].tool).toBe('request_user_input')
})

it('keeps native patch paths, diffs and failure output through the chat pipeline', () => {
    const path = 'src/app.ts'
    const change = { path, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }
    const projected = projectNativeItems([
        { item: { id: 'patch', type: 'fileChange', changes: [change], status: 'failed', stderr: 'Hunk did not match' } },
    ], [])
    const normalized = projected.messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
    const reduced = reduceChatBlocks(normalized, { requests: projected.requests })
    expect(reduced.blocks).toMatchObject([{
        kind: 'tool-call',
        tool: {
            name: 'CodexPatch',
            state: 'error',
            input: { changes: { [path]: change } },
            result: { status: 'failed', stderr: 'Hunk did not match' },
        },
    }])
})

it('projects a completed image generation as a media block backed by its native file', () => {
    const savedPath = String.raw`C:\exports\generated image.webp`
    const projected = projectNativeItems([
        { item: { id: 'image', type: 'imageGeneration', status: 'completed', savedPath, result: 'large-image-result' } },
    ], [])
    const normalized = projected.messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
    const reduced = reduceChatBlocks(normalized, { requests: projected.requests })
    expect(reduced.blocks).toMatchObject([{
        kind: 'generated-image', imageId: 'image', nativeFilePath: savedPath,
        fileName: 'generated image.webp', mimeType: 'image/webp',
    }])
    expect(JSON.stringify(projected.messages)).not.toContain('large-image-result')
})
