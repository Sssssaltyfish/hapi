import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SelectedTextQuote } from './SelectedTextQuote'

const { setText } = vi.hoisted(() => ({ setText: vi.fn() }))
vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({ composer: () => ({ setText }) }),
    useAuiState: (select: (state: unknown) => unknown) => select({ composer: { text: 'Existing draft' } })
}))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: () => 'Quote selected text' }) }))
afterEach(() => { window.getSelection()?.removeAllRanges(); vi.clearAllMocks() })

it('quotes selected assistant text into the existing draft without submitting', () => {
    const scope = createRef<HTMLDivElement>()
    render(<><div ref={scope}><div data-hapi-message-role="assistant">Line one<br />Line two</div></div><SelectedTextQuote scope={scope} /></>)
    const range = document.createRange()
    range.selectNodeContents(scope.current!.firstChild!)
    window.getSelection()!.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    fireEvent.click(screen.getByRole('button', { name: 'Quote selected text' }))
    expect(setText).toHaveBeenCalledTimes(1)
    expect(setText.mock.calls[0][0]).toMatch(/^Existing draft\n\n> Line one/)
    expect(window.getSelection()!.isCollapsed).toBe(true)
})

it('does not quote a selection outside this conversation', () => {
    const scope = createRef<HTMLDivElement>()
    render(<><div ref={scope} /><div data-hapi-message-role="assistant" data-testid="outside">Other conversation</div><SelectedTextQuote scope={scope} /></>)
    const range = document.createRange()
    range.selectNodeContents(screen.getByTestId('outside'))
    window.getSelection()!.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    expect(screen.queryByRole('button', { name: 'Quote selected text' })).toBeNull()
})
