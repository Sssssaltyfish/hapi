import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DisclosureContent } from './disclosure'

const originalGetAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getAnimations')
afterEach(() => {
    if (originalGetAnimations) Object.defineProperty(HTMLElement.prototype, 'getAnimations', originalGetAnimations)
    else delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations
})

function transition() {
    let finish!: (animation: Animation) => void
    const finished = new Promise<Animation>(resolve => { finish = resolve })
    const animation = { finished } as Animation
    return { animation, finish: () => finish(animation) }
}

function Counter() {
    const [value, setValue] = useState(0)
    return <button onClick={() => setValue(value + 1)}>Count {value}</button>
}

describe('chat disclosure content', () => {
    it('mounts expensive content on demand and unmounts only after its uncancelled close finishes', async () => {
        const first = transition()
        const second = transition()
        const animations = vi.fn().mockReturnValue([first.animation])
        Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: animations })
        const content = vi.fn(() => <Counter />)
        const view = render(<DisclosureContent open={false} id="details">{content}</DisclosureContent>)
        expect(content).not.toHaveBeenCalled()
        view.rerender(<DisclosureContent open id="details">{content}</DisclosureContent>)
        fireEvent.click(await view.findByRole('button', { name: 'Count 0' }))
        view.rerender(<DisclosureContent open={false} id="details">{content}</DisclosureContent>)
        expect(view.container.querySelector('#details')).toHaveAttribute('inert')
        expect(view.getByText('Count 1')).toBeInTheDocument()
        view.rerender(<DisclosureContent open id="details">{content}</DisclosureContent>)
        await act(async () => { first.finish() })
        expect(view.getByRole('button', { name: 'Count 1' })).toBeInTheDocument()
        animations.mockReturnValue([second.animation])
        view.rerender(<DisclosureContent open={false} id="details">{content}</DisclosureContent>)
        expect(view.getByText('Count 1')).toBeInTheDocument()
        await act(async () => { second.finish() })
        await waitFor(() => expect(view.queryByText('Count 1')).not.toBeInTheDocument())
    })

    it('preserves an opened reader and its state when requested, including without motion', async () => {
        Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] })
        const view = render(<DisclosureContent open id="reader" keepMounted><Counter /></DisclosureContent>)
        fireEvent.click(view.getByRole('button', { name: 'Count 0' }))
        const reader = view.getByRole('button', { name: 'Count 1' })
        view.rerender(<DisclosureContent open={false} id="reader" keepMounted><Counter /></DisclosureContent>)
        expect(reader).toBeInTheDocument()
        view.rerender(<DisclosureContent open id="reader" keepMounted><Counter /></DisclosureContent>)
        expect(view.getByRole('button', { name: 'Count 1' })).toBe(reader)
    })
})
