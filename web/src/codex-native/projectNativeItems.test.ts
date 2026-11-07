import { expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { projectNativeItems } from './projectNativeItems'

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
