import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkDisclosure } from './WorkDisclosure'
import { createWorkExpansionState } from '../workExpansion'

const state = vi.hoisted(() => ({ expansion: null as ReturnType<typeof createWorkExpansionState> | null }))
vi.mock('@/components/AssistantChat/context', () => ({ useOptionalWorkExpansionState: () => state.expansion }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key === 'session.work.running' ? 'Working' : 'Work' }) }))
afterEach(cleanup)

it('shows running work, collapses after completion, remembers expansion only within the chat', () => {
    state.expansion = createWorkExpansionState()
    const active = { turnId: 'turn', canCollapse: false, finalKnown: false, blocked: true, active: true }
    const completed = { ...active, canCollapse: true, finalKnown: true, blocked: false, active: false }
    const view = render(<WorkDisclosure work={active}><p>Tool and commentary</p></WorkDisclosure>)
    const disclosure = () => screen.getByText('Tool and commentary').closest('details')!
    expect(disclosure().open).toBe(true)
    fireEvent.click(screen.getByText('Working'))
    expect(disclosure().open).toBe(true)
    view.rerender(<WorkDisclosure work={completed}><p>Tool and commentary</p></WorkDisclosure>)
    expect(disclosure().open).toBe(false)
    fireEvent.click(screen.getByText('Work'))
    expect(disclosure().open).toBe(true)
    view.unmount()
    const remounted = render(<WorkDisclosure work={completed}><p>Tool and commentary</p></WorkDisclosure>)
    expect(disclosure().open).toBe(true)
    remounted.unmount()
    state.expansion = createWorkExpansionState()
    render(<WorkDisclosure work={completed}><p>Tool and commentary</p></WorkDisclosure>)
    expect(disclosure().open).toBe(false)
})

it('lets inactive work without a loaded final answer be manually closed while keeping its default open', () => {
    state.expansion = createWorkExpansionState()
    const work = { turnId: 'historical-turn', canCollapse: false, finalKnown: false, blocked: false, active: false }
    const view = render(<WorkDisclosure work={work}><p>Historical commentary</p></WorkDisclosure>)
    const disclosure = () => screen.getByText('Historical commentary').closest('details')!
    expect(disclosure().open).toBe(true)
    fireEvent.click(screen.getByText('Work'))
    expect(disclosure().open).toBe(false)
    view.rerender(<WorkDisclosure work={{ ...work }}><p>Historical commentary</p></WorkDisclosure>)
    expect(disclosure().open).toBe(false)
    view.rerender(<WorkDisclosure work={{ ...work, blocked: true }}><p>Historical commentary</p></WorkDisclosure>)
    expect(disclosure().open).toBe(true)
    fireEvent.click(screen.getByText('Work'))
    expect(disclosure().open).toBe(true)
})
