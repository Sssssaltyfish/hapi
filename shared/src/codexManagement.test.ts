import { describe, expect, test } from 'bun:test'
import { CodexGuardianDenials, codexRecap, codexUsage } from './codexManagement'

describe('Codex management protocol', () => {
    test('accepts only an observed same-thread denial and claims its exact action once', () => {
        const denials = new CodexGuardianDenials()
        const event = { threadId: 'thread', turnId: 'turn', reviewId: 'review', targetItemId: 'item',
            startedAtMs: 1, completedAtMs: 2, decisionSource: 'agent',
            review: { status: 'denied', riskLevel: 'high', userAuthorization: 'low', rationale: 'Review this command' },
            action: { type: 'command', source: 'unifiedExec', command: 'echo exact', cwd: '/project' } }
        denials.observe('thread', 'item/autoApprovalReview/completed', { ...event, threadId: 'other' })
        expect(denials.show()).toBeNull()
        denials.observe('thread', 'item/autoApprovalReview/completed', event)
        expect(denials.claim('forged')).toBeNull()
        expect(denials.show()?.reviewId).toBe('review')
        expect(denials.claim('review')).toMatchObject({ id: 'review', turn_id: 'turn', status: 'denied',
            action: { type: 'command', source: 'unified_exec', command: 'echo exact', cwd: '/project' } })
        denials.observe('thread', 'item/autoApprovalReview/completed', event)
        expect(denials.claim('review')).toBeNull()
        denials.observe('thread', 'item/autoApprovalReview/completed', { ...event, reviewId: 'next' })
        denials.observe('thread', 'turn/started', { threadId: 'thread', turn: { id: 'later' } })
        expect(denials.show()).toBeNull()
        denials.observe('thread', 'item/autoApprovalReview/completed', { ...event, reviewId: 'permission', action: {
            type: 'requestPermissions', reason: 'One directory', permissions: { network: null, fileSystem: {
                read: null, write: null, entries: [{ path: { type: 'path', path: '/project/only' }, access: 'write' }], globScanMaxDepth: 2,
            } },
        } })
        expect(denials.claim('permission')?.action).toEqual({ type: 'request_permissions', reason: 'One directory',
            permissions: { network: null, file_system: { entries: [{ path: { type: 'path', path: '/project/only' }, access: 'write' }], glob_scan_max_depth: 2 } } })
    })

    test('uses the exact raw guardian assessment without accepting a user-authored RPC payload', () => {
        const denials = new CodexGuardianDenials()
        const event = { id: 'review', turn_id: 'turn', status: 'denied', decision_source: 'agent',
            action: { type: 'mcp_tool_call', server: 'server', tool_name: 'safe-tool' } }
        denials.observe('thread', 'codex/event/guardian_assessment', { threadId: 'thread', msg: event })
        expect(denials.claim('review')).toEqual(event)
        denials.observe('thread', 'codex/event/guardian_assessment', { threadId: 'thread', msg: { ...event, id: 'non-agent', decision_source: 'user' } })
        expect(denials.show()).toBeNull()
        denials.observe('thread', 'codex/event/guardian_assessment', { threadId: 'thread', msg: { ...event, id: 'unknown-action', action: { type: 'future_action' } } })
        expect(denials.show()).toBeNull()
    })

    test('recaps an idle source via a separate sample and verifies its source turn', async () => {
        const calls: Array<{ method: string; params: Record<string, unknown> }> = []
        let active = false
        let sourceTurnId = 'turn'
        const recap = 'Completed the migration.\n\nNext: ' + 'Review the remaining integration work. '.repeat(15)
        const request = async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params })
            return method === 'thread/turns/list'
                ? { data: [{ id: 'turn', status: active ? 'inProgress' : 'completed' }] }
                : { sourceTurnId, text: ` ${recap} ` }
        }
        expect(await codexRecap(request, 'thread')).toEqual({ command: 'recap', sourceTurnId: 'turn', text: recap.trim() })
        expect(calls[1]).toMatchObject({ method: 'thread/sample', params: { threadId: 'thread', expectedTurnId: 'turn', disableMcp: true } })
        expect(calls.some(call => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(call.method))).toBe(false)
        sourceTurnId = 'other'
        await expect(codexRecap(request, 'thread')).rejects.toThrow('confirmed')
        active = true
        const before = calls.length
        await expect(codexRecap(request, 'thread')).rejects.toThrow('idle')
        expect(calls.length - before).toBe(1)
    })

    test('retains available native usage when the account does not expose rate limits', async () => {
        const usage = { summary: { lifetimeTokens: 123 }, threadUsage: null }
        expect(await codexUsage(async (method, params) => {
            if (method === 'account/rateLimits/read') throw new Error('Rate limits unavailable for this account')
            expect(params).toEqual({ threadId: 'thread' })
            return usage
        }, 'thread')).toMatchObject({ command: 'usage', snapshot: { summary: { lifetimeTokens: '123' }, thread: null, limits: [],
            unavailable: { rateLimits: 'Rate limits unavailable for this account' } } })
    })

    test('unsupported sampling returns bounded existing conversation excerpts without inference or mutation', async () => {
        const calls: string[] = []
        const result = await codexRecap(async (method, params) => {
            calls.push(method)
            if (method === 'thread/sample') throw new Error('Invalid request: unknown variant `thread/sample`, expected one of ' + 'internal methods, '.repeat(100))
            expect(method).toBe('thread/turns/list')
            return { data: [{ id: 'turn', status: 'completed', items: params.itemsView === 'full' ? [
                { type: 'userMessage', content: [{ type: 'text', text: 'Fix the setting' }] },
                { type: 'agentMessage', phase: 'commentary', text: 'Private progress should not be selected' },
                { type: 'agentMessage', phase: 'final_answer', text: 'Fixed and verified. '.repeat(200) },
                { type: 'plan', text: 'Verify the setting' },
            ] : [] }] }
        }, 'thread')
        expect(result).toMatchObject({ source: 'history', sourceTurnId: 'turn' })
        expect(result.text).toContain('Recent conversation excerpts')
        expect(result.text).toContain('Latest request\nFix the setting')
        expect(result.text).toContain('Latest response\nFixed and verified.')
        expect(result.text).toContain('Latest plan\nVerify the setting')
        expect(result.text).not.toContain('Private progress')
        expect(result.text).not.toContain('internal methods')
        expect(result.text.length).toBeLessThan(2200)
        expect(calls).toEqual(['thread/turns/list', 'thread/sample', 'thread/turns/list'])
    })

    test('older hosts read stored turns; metadata preview is never presented as a recap', async () => {
        const calls: string[] = []
        const result = await codexRecap(async method => {
            calls.push(method)
            if (method === 'thread/turns/list') throw Object.assign(new Error('Method not found'), { code: -32601 })
            expect(method).toBe('thread/read')
            return { thread: { preview: 'Initial prompt only', turns: [{ id: 'old', status: 'completed', items: [
                { type: 'agentMessage', text: 'Actual final response' },
            ] }] } }
        }, 'thread')
        expect(result.source).toBe('history')
        expect(result.text).toContain('Actual final response')
        expect(result.text).not.toContain('Initial prompt only')
        expect(calls).not.toContain('thread/sample')
        expect(calls).not.toContain('getConversationSummary')
    })

    test('does not fall back or leak raw errors after an inference or transport failure', async () => {
        const calls: string[] = []
        await expect(codexRecap(async method => {
            calls.push(method)
            if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'completed' }] }
            throw new Error('HTTP 429 ' + 'sensitive internal detail '.repeat(100))
        }, 'thread')).rejects.toThrow('Recap is unavailable because of an account usage limit. Check your allowance before retrying.')
        expect(calls).toEqual(['thread/turns/list', 'thread/sample'])
    })

    test('empty legacy history returns one concise error without attempting a model call', async () => {
        const calls: string[] = []
        await expect(codexRecap(async method => {
            calls.push(method)
            if (method === 'thread/turns/list') throw new Error('unknown variant `thread/turns/list`')
            return { thread: { preview: 'A title is not a recap', turns: [] } }
        }, 'thread')).rejects.toThrow('No completed conversation is available to recap.')
        expect(calls).not.toContain('thread/sample')
        expect(calls).not.toContain('turn/start')
    })

    test('history fallback stays bound to the sampled source after another turn finishes', async () => {
        let reads = 0
        const result = await codexRecap(async method => {
            if (method === 'thread/sample') throw new Error('unknown variant `thread/sample`')
            reads++
            return { data: reads === 1 ? [{ id: 'source', status: 'completed' }] : [
                { id: 'newer', status: 'completed', items: [{ type: 'agentMessage', text: 'New response' }] },
                { id: 'source', status: 'completed', items: [{ type: 'agentMessage', text: 'Bound response' }] },
            ] }
        }, 'thread')
        expect(result.sourceTurnId).toBe('source')
        expect(result.text).toContain('Bound response')
        expect(result.text).not.toContain('New response')
        reads = 0
        await expect(codexRecap(async method => {
            if (method === 'thread/sample') throw new Error('unknown variant `thread/sample`')
            return { data: [{ id: ++reads === 1 ? 'source' : 'newer', status: 'completed' }] }
        }, 'thread')).rejects.toThrow('The conversation changed while reading the recap. Run /recap again.')
    })

    test('network sampling failure offers reconnect without attempting history fallback', async () => {
        const calls: string[] = []
        await expect(codexRecap(async method => {
            calls.push(method)
            if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'completed' }] }
            throw new Error('WebSocket connection closed: internal details')
        }, 'thread')).rejects.toThrow('Recap could not connect to Codex. Reconnect and try again.')
        expect(calls).toEqual(['thread/turns/list', 'thread/sample'])
    })
})
