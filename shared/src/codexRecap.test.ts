import { describe, expect, test } from 'bun:test'
import { codexRecap, type CodexRecapTransport } from './codexRecap'
import { CODEX_RECAP_PROMPT_MAX_BYTES, codexRecapPrompt } from './codexRecapPrompt'

type Value = Record<string, unknown>
function fixture() {
    const listeners = new Set<(event: { method: string; params?: unknown }) => void>()
    const calls: Array<{ method: string; params: Value }> = []
    const source = { id: 'source', model: 'chosen-model', modelProvider: 'chosen-provider', cwd: '/work', status: { type: 'idle' } }
    const state = { summary: '迁移已经完成并通过测试，尚未部署。', next: '确认后部署。', noCompletion: false }
    const emit = (method: string, params: unknown) => { for (const listener of listeners) listener({ method, params }) }
    const request = async (method: string, params: Value): Promise<unknown> => {
        calls.push({ method, params })
        if (method === 'thread/read') return { thread: source }
        if (method === 'thread/turns/list') {
            return { data: [{ id: 'source-turn', status: 'completed', items: [
                { type: 'userMessage', content: [{ type: 'text', text: '验证迁移结果。' }] },
                { type: 'reasoning', text: 'Private reasoning' }, { type: 'commandExecution', aggregatedOutput: 'Private tool output' },
                { type: 'agentMessage', text: '迁移已完成，测试通过。', phase: 'final_answer' },
            ] }] }
        }
        if (method === 'config/read') return { config: { mcp_servers: { hapi: { enabled: true }, external: { enabled: true } } } }
        if (method === 'thread/start') return { thread: { id: 'helper', ephemeral: true }, sandbox: { type: 'readOnly' } }
        if (method === 'turn/start') {
            // Events deliberately arrive before the turn/start response.
            emit('turn/started', { threadId: 'helper', turn: { id: 'helper-turn' } })
            emit('item/completed', { threadId: 'unrelated', turnId: 'helper-turn', item: { type: 'agentMessage', text: 'Wrong thread' } })
            emit('item/completed', { threadId: 'helper', turnId: 'unrelated-turn', item: { type: 'agentMessage', text: 'Wrong turn' } })
            if (!state.noCompletion) {
                emit('item/completed', { threadId: 'helper', turnId: 'helper-turn', item: { type: 'agentMessage', text: JSON.stringify({ summary: state.summary, next_action: state.next }) } })
                emit('turn/completed', { threadId: 'helper', turn: { id: 'helper-turn', status: 'completed' } })
            }
            return { turn: { id: 'helper-turn' } }
        }
        return {}
    }
    const transport: CodexRecapTransport = { request, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    return { transport, calls, state, listeners, emit }
}

describe('Codex ephemeral conversation recap', () => {
    test('buffers early events, keeps localized fields, disables tools, and detaches without source writes', async () => {
        const { transport, calls, state, listeners } = fixture()
        expect(await codexRecap(transport, 'source')).toEqual({ command: 'recap', sourceTurnId: 'source-turn', text: `${state.summary}\n\n${state.next}` })
        const start = calls.find(call => call.method === 'thread/start')!.params
        expect(start).toMatchObject({ model: 'chosen-model', modelProvider: 'chosen-provider', cwd: '/work', ephemeral: true,
            threadSource: 'system', sandbox: 'read-only', runtimeWorkspaceRoots: [], environments: [], dynamicTools: [], selectedCapabilityRoots: [],
            config: { 'features.hooks': false, 'features.memories': false, 'features.plugins': false, 'features.shell_tool': false,
                'skills.include_instructions': false, 'cloud.skills.enabled': false, web_search: 'disabled', default_permissions: ':read-only',
                mcp_servers: { hapi: { enabled: false }, external: { enabled: false } } } })
        const turn = calls.find(call => call.method === 'turn/start')!.params
        expect(turn.threadId).toBe('helper')
        expect(turn.outputSchema).toMatchObject({ required: ['summary', 'next_action'], additionalProperties: false })
        expect(JSON.stringify(turn.input)).toContain('验证迁移结果')
        expect(JSON.stringify(turn.input)).not.toContain('Private reasoning')
        expect(JSON.stringify(turn.input)).not.toContain('Private tool output')
        expect(calls.at(-1)).toEqual({ method: 'thread/unsubscribe', params: { threadId: 'helper' } })
        expect(calls.filter(call => ['turn/start', 'turn/interrupt', 'thread/unsubscribe', 'thread/settings/update', 'thread/fork', 'thread/sample'].includes(call.method))
            .every(call => call.params.threadId === 'helper')).toBe(true)
        expect(listeners.size).toBe(0)
    })

    test('source events interrupt generation immediately and only target the helper', async () => {
        const { transport, calls, state, emit, listeners } = fixture()
        state.noCompletion = true
        const result = codexRecap(transport, 'source')
        while (!calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setTimeout(resolve, 1))
        emit('turn/started', { threadId: 'source', turn: { id: 'new-source-turn' } })
        await expect(result).rejects.toThrow('conversation changed')
        expect(calls.slice(-2)).toEqual([{ method: 'turn/interrupt', params: { threadId: 'helper', turnId: 'helper-turn' } },
            { method: 'thread/unsubscribe', params: { threadId: 'helper' } }])
        expect(listeners.size).toBe(0)
    })

    test('times out and interrupts a running helper, then removes its listener', async () => {
        const { transport, state, calls, listeners } = fixture()
        state.noCompletion = true
        await expect(codexRecap(transport, 'source', { timeoutMs: 10 })).rejects.toThrow('timed out')
        expect(calls.slice(-2).map(call => call.method)).toEqual(['turn/interrupt', 'thread/unsubscribe'])
        expect(listeners.size).toBe(0)
    })

})

describe('Codex recap prompt history selection', () => {
    test('keeps recent visible exchanges in order including steering and pending correction', () => {
        const prompt = codexRecapPrompt([{ items: [
            { type: 'userMessage', content: [{ type: 'text', text: 'Earlier request' }] },
            { type: 'agentMessage', text: 'Earlier answer' },
            { type: 'userMessage', content: [{ type: 'text', text: 'Latest request' }] },
            { type: 'userMessage', content: [{ type: 'text', text: 'Steering correction' }] },
        ] }])
        expect(prompt.slice(prompt.indexOf('Conversation:\n'))).toBe('Conversation:\nUser: Earlier request\n\nAssistant: Earlier answer\n\nPending user request: Latest request\n\nSteering correction')
    })

    test('bounds UTF-8 bytes, preserves both ends, and excludes tool and reasoning output', () => {
        const prompt = codexRecapPrompt(Array.from({ length: 12 }, (_, index) => ({ items: [
            { type: 'userMessage', content: [{ type: 'text', text: `request${index}首` + '😀中文'.repeat(10_000) + `尾request${index}` }] },
            { type: 'agentMessage', text: `answer${index}首` + '😀中文'.repeat(10_000) + `尾answer${index}` },
            { type: 'commandExecution', aggregatedOutput: 'Never send tools' }, { type: 'reasoning', text: 'Never send reasoning' },
        ] })))
        expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(CODEX_RECAP_PROMPT_MAX_BYTES)
        expect(prompt).toContain('request11首')
        expect(prompt).toContain('尾request11')
        expect(prompt).toContain('answer11首')
        expect(prompt).toContain('尾answer11')
        expect(prompt).not.toContain('request0首')
        expect(prompt).not.toContain('Never send')
        expect(prompt).not.toContain('\uFFFD')
    })
})
