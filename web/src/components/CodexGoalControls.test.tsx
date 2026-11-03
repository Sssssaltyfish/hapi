import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import type { ThreadGoal } from '@/types/api'
import type { CodexGoalControlRequest } from '@hapi/protocol/codexGoalControl'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexGoalControls } from './CodexGoalControls'

const goal: ThreadGoal = { threadId: 'thread', objective: 'Keep the task paused', status: 'paused', tokenBudget: 100,
    tokensUsed: 10, timeUsedSeconds: 2, createdAt: 1, updatedAt: 1 }
it('cancels editing without a mutation and saves a paused objective without resuming it', async () => {
    const action = vi.fn()
    function Harness() {
        const [value, setValue] = useState(goal)
        const [editing, setEditing] = useState(false)
        return <CodexGoalControls goal={value} editing={editing} onEditingChange={setEditing} disabled={false} pending={false}
            onAction={async command => { action(command); if (command.action === 'edit') setValue({ ...value, objective: command.objective }); return true }} />
    }
    render(<I18nProvider><Harness /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), { target: { value: 'Discard this edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(action).not.toHaveBeenCalled()
    expect(screen.getByText(goal.objective)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), { target: { value: 'New paused objective' } })
    expect(screen.getByText('Changing the objective restarts goal usage accounting.')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save goal' })))
    expect(action).toHaveBeenCalledExactlyOnceWith({ action: 'edit', objective: 'New paused objective', expectedObjective: goal.objective })
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
})

it('opens an editable empty goal and distinguishes starting from clearing it', async () => {
    const action = vi.fn<(command: CodexGoalControlRequest) => Promise<boolean>>().mockResolvedValue(true)
    render(<I18nProvider><CodexGoalControls goal={null} editing onEditingChange={() => {}} disabled={false} pending={false} onAction={action} /></I18nProvider>)
    expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveClass('hapi-composer-field')
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Clear goal' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), { target: { value: 'Build the feature' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start goal' })))
    expect(action).toHaveBeenCalledExactlyOnceWith({ action: 'set', objective: 'Build the feature' })
})

it('keeps an edited draft when another client changes the goal and blocks a stale save', () => {
    const props = { editing: true, onEditingChange: vi.fn(), disabled: false, pending: false, onAction: vi.fn() }
    const { rerender } = render(<I18nProvider><CodexGoalControls {...props} goal={goal} /></I18nProvider>)
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), { target: { value: 'My unsaved edit' } })
    rerender(<I18nProvider><CodexGoalControls {...props} goal={{ ...goal, objective: 'External edit' }} /></I18nProvider>)
    expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveValue('My unsaved edit')
    expect(screen.getByRole('button', { name: 'Save goal' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('The goal changed elsewhere')
    expect(props.onAction).not.toHaveBeenCalled()
})
