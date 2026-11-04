import { describe, expect, it, vi } from 'vitest'
const harness = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('./sdk/query', () => ({ query: harness.query }))
import { createClaudeSideRecap } from './claudeSideRecap'

describe('Claude isolated recap', () => {
    it('uses a non-persistent native fork with tools and hooks disabled', async () => {
        harness.query.mockImplementation(async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'temporary-fork' }
            yield { type: 'result', subtype: 'success', result: 'Completed the migration.\nOne follow-up remains.' }
        })
        await expect(createClaudeSideRecap({ sessionId: 'original-session', cwd: '/workspace',
            signal: new AbortController().signal })).resolves.toBe('Completed the migration. One follow-up remains.')
        expect(harness.query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
            resume: 'original-session', forkSession: true, permissionMode: 'default', strictMcpConfig: true,
            mcpServers: {}, maxTurns: 1,
            additionalArgs: ['--tools', '', '--no-session-persistence', '--disable-slash-commands', '--settings', '{"disableAllHooks":true}']
        }) }))
    })
})
