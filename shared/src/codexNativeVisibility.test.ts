import { describe, expect, test } from 'bun:test'
import { isNativeBackgroundThread } from './codexNativeVisibility'

describe('native directory provenance', () => {
    test.each([
        { source: 'cli' }, { source: 'vscode' }, { source: 'appServer', threadSource: 'user' }, { source: 'unknown' },
    ])('does not invent background provenance for %j', thread => { expect(isNativeBackgroundThread(thread)).toBe(false) })
    test.each([
        { source: 'exec' }, { source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } },
        { source: 'subAgentThreadSpawn' }, { source: 'appServer', parentThreadId: 'root' },
        { source: 'appServer', ephemeral: true }, { source: 'appServer', threadSource: 'agent_created_thread' },
        { source: 'cli', originator: 'codex_exec' },
    ])('recognizes positive background provenance for %j', thread => { expect(isNativeBackgroundThread(thread)).toBe(true) })
})
