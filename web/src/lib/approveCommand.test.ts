import { expect, it, vi } from 'vitest'
import type { AgentState, SlashCommand } from '@/types/api'
import { pendingApprovalBlock, submitApproveCommand } from './approveCommand'

const builtin: SlashCommand[] = [{ name: 'approve', source: 'builtin', description: 'Show a pending approval' }]
const state: AgentState = { requests: {
    question: { tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Choose a color' }] }, createdAt: 1 },
    request: { tool: 'Bash', toolCallId: 'different-tool-id', arguments: { command: 'git diff --stat' }, createdAt: 2 },
} }
const input = () => ({ text: '/approve', flavor: 'dsh', active: true, state, commands: builtin, open: vi.fn() })

it.each(['user', 'project', 'plugin'] as const)('keeps the provider or %s command ahead of the local approval shortcut', async source => {
    const args = input()
    const resolveCommands = vi.fn().mockResolvedValue([{ name: 'approve', source }])
    expect(await submitApproveCommand({ ...args, resolveCommands })).toBe('unhandled')
    expect(args.open).not.toHaveBeenCalled()
})

it('preserves an explicitly reported native command without waiting for another catalog read', async () => {
    const args = input()
    const resolveCommands = vi.fn()
    expect(await submitApproveCommand({ ...args, nativeCommands: ['approve'], resolveCommands })).toBe('unhandled')
    expect(resolveCommands).not.toHaveBeenCalled()
    expect(args.open).not.toHaveBeenCalled()
})

it('opens the real request with its original action, keeping request and tool IDs separate', async () => {
    const args = input()
    expect(await submitApproveCommand(args)).toBe('handled')
    expect(args.open).toHaveBeenCalledExactlyOnceWith('request')
    const block = pendingApprovalBlock(state, 'request')!
    expect(block.id).toBe('different-tool-id')
    expect(block.tool.permission).toMatchObject({ id: 'request', status: 'pending' })
    expect(block.tool.input).toEqual({ command: 'git diff --stat' })
})

it('leaves unavailable directories, absent approvals, ordinary questions and arguments to the provider adapter', async () => {
    const args = input()
    for (const changed of [
        { resolveCommands: async () => null },
        { state: null },
        { state: { requests: { question: state.requests!.question } } },
        { state: { requests: { question: { tool: 'request_user_input', arguments: {} } } } },
        { text: '/approve yes' }, { flavor: 'codex' }, { active: false },
    ]) expect(await submitApproveCommand({ ...args, ...changed })).toBe('unhandled')
    expect(args.open).not.toHaveBeenCalled()
})

it('does not reopen an answered request or substitute another request after it disappears', () => {
    expect(pendingApprovalBlock({ ...state, completedRequests: {
        request: { tool: 'Bash', arguments: {}, status: 'approved' },
    } })).toBeNull()
    expect(pendingApprovalBlock({ requests: { other: state.requests!.request } }, 'request')).toBeNull()
})

it('uses a fresh synchronous catalog for the approval shortcut', () => {
    const args = input()
    expect(submitApproveCommand({ ...args, resolveCommands: () => builtin })).toBe('handled')
    expect(args.open).toHaveBeenCalledExactlyOnceWith('request')
})

it('routes uncertain ownership synchronously so a delayed provider result cannot consume a newer draft', async () => {
    const args = input()
    let resolve!: (commands: SlashCommand[]) => void
    const directory = new Promise<SlashCommand[]>(done => { resolve = done })
    const outcome = submitApproveCommand({ ...args, resolveCommands: () => directory })
    expect(outcome).toBe('unhandled')
    resolve([{ name: 'approve', source: 'plugin' }])
    await directory
    expect(args.open).not.toHaveBeenCalled()
})
