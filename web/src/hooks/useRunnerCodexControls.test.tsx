import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session, ThreadGoal } from '@/types/api'
import { useRunnerCodexControls } from './useRunnerCodexControls'

const goal: ThreadGoal = { threadId: 'thread', objective: 'Finish the task', status: 'active', tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }
const session = { id: 'session', active: true, collaborationMode: 'plan',
    metadata: { flavor: 'codex', capabilities: { concurrentClients: true } }, agentState: { codexGoal: goal } } as Session

it('uses typed goal actions and the existing collaboration mode API without sending chat text', async () => {
    const pause = { ...goal, status: 'paused' as const }
    const controlCodexGoal = vi.fn().mockResolvedValue({ goal: pause })
    const setCollaborationMode = vi.fn().mockResolvedValue(undefined)
    const api = { controlCodexGoal, setCollaborationMode } as unknown as ApiClient
    const { result } = renderHook(() => useRunnerCodexControls(api, session, false))
    await act(async () => { await result.current.controlGoal({ action: 'pause' }) })
    expect(controlCodexGoal).toHaveBeenCalledExactlyOnceWith('session', { action: 'pause' })
    expect(result.current.goal?.status).toBe('paused')
    await act(async () => { await result.current.leavePlan() })
    expect(setCollaborationMode).toHaveBeenCalledExactlyOnceWith('session', 'default')
})

it('opens the editor for a missing goal and keeps edit mutations separate from resume', async () => {
    const controlCodexGoal = vi.fn().mockResolvedValueOnce({ goal: null }).mockResolvedValueOnce({ goal: { ...goal, objective: 'Edited', status: 'paused' } })
    const { result } = renderHook(() => useRunnerCodexControls({ controlCodexGoal } as unknown as ApiClient,
        { ...session, agentState: { codexGoal: null } }, false))
    await act(async () => { expect(await result.current.controlGoal({ action: 'show' })).toBe(true) })
    expect(result.current.goalEditorOpen).toBe(true)
    expect(result.current.goal).toBeNull()
    await act(async () => { await result.current.controlGoal({ action: 'edit', objective: 'Edited', expectedObjective: goal.objective }) })
    expect(controlCodexGoal).toHaveBeenLastCalledWith('session', { action: 'edit', objective: 'Edited', expectedObjective: goal.objective })
    expect(result.current.goal?.status).toBe('paused')
})

it('keeps an external goal update that arrives before an older control response', async () => {
    let resolve!: (value: { goal: ThreadGoal | null }) => void
    const api = { controlCodexGoal: vi.fn().mockImplementation(() => new Promise(done => { resolve = done })) } as unknown as ApiClient
    const { result, rerender } = renderHook(({ value }) => useRunnerCodexControls(api, value, false), { initialProps: { value: session } })
    let pending!: Promise<boolean>
    act(() => { pending = result.current.controlGoal({ action: 'pause' }) })
    const external = { ...goal, objective: 'New external objective', status: 'active' as const, updatedAt: 2 }
    rerender({ value: { ...session, agentState: { codexGoal: external } } })
    await act(async () => { resolve({ goal: { ...goal, status: 'paused' } }); await pending })
    expect(result.current.goal).toEqual(external)
})

it('does not offer Runner controls to Native or another agent backend', async () => {
    const controlCodexGoal = vi.fn()
    const api = { controlCodexGoal } as unknown as ApiClient
    const { result } = renderHook(() => useRunnerCodexControls(api, session, true))
    await act(async () => { await result.current.controlGoal({ action: 'clear' }) })
    expect(result.current.enabled).toBe(false)
    expect(controlCodexGoal).not.toHaveBeenCalled()
})

it('keeps older Runners without a goal snapshot on their existing slash-command path', () => {
    const { result } = renderHook(() => useRunnerCodexControls({} as ApiClient, { ...session, agentState: {} }, false))
    expect(result.current.enabled).toBe(true)
    expect(result.current.goalControlsAvailable).toBe(false)
})

it('accepts an acknowledgement when an unrelated state packet repeats the same goal', async () => {
    let resolve!: (value: { goal: ThreadGoal | null }) => void
    const api = { controlCodexGoal: vi.fn().mockImplementation(() => new Promise(done => { resolve = done })) } as unknown as ApiClient
    const { result, rerender } = renderHook(({ value }) => useRunnerCodexControls(api, value, false), { initialProps: { value: session } })
    let pending!: Promise<boolean>
    act(() => { pending = result.current.controlGoal({ action: 'pause' }) })
    rerender({ value: { ...session, agentState: { codexGoal: { ...goal } } } })
    await act(async () => { resolve({ goal: { ...goal, status: 'paused' } }); await pending })
    expect(result.current.goal?.status).toBe('paused')
})

it('keeps the displayed goal when native clear is not acknowledged', async () => {
    const api = { controlCodexGoal: vi.fn().mockResolvedValue({ goal: null, cleared: false }) } as unknown as ApiClient
    const { result } = renderHook(() => useRunnerCodexControls(api, session, false))
    await act(async () => { await result.current.controlGoal({ action: 'clear' }) })
    expect(result.current.goal).toEqual(goal)
    expect(result.current.error).toContain('not cleared')
})
