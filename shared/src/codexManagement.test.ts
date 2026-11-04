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
        const request = async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params })
            return method === 'thread/turns/list'
                ? { data: [{ id: 'turn', status: active ? 'inProgress' : 'completed' }] }
                : { sourceTurnId, text: ' A short recap. ' }
        }
        expect(await codexRecap(request, 'thread')).toEqual({ command: 'recap', sourceTurnId: 'turn', text: 'A short recap.' })
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
        }, 'thread')).toEqual({ command: 'usage', usage, rateLimits: null,
            unavailable: { rateLimits: 'Rate limits unavailable for this account' } })
    })
})
