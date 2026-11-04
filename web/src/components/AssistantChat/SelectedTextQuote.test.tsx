import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SelectedTextQuote } from './SelectedTextQuote'
import { splitResponseAnnotations } from '@/lib/responseAnnotations'

const { setText } = vi.hoisted(() => ({ setText: vi.fn() }))
const context = vi.hoisted(() => ({ metadata: null as null | { flavor?: string; nativeCodex?: object } }))
const platform = vi.hoisted(() => ({ isTouch: false }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => platform }))
vi.mock('./context', () => ({ useOptionalHappyChatContext: () => ({ metadata: context.metadata, disabled: false }) }))
vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({ composer: () => ({ setText }) }),
    useAuiState: (select: (state: unknown) => unknown) => select({ composer: { text: 'Existing draft' } })
}))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: () => 'Quote selected text' }) }))
afterEach(() => { window.getSelection()?.removeAllRanges(); vi.clearAllMocks(); context.metadata = null; platform.isTouch = false })

it('keeps touch quoting in a transient chat action row while preserving native menus and selection handles', () => {
    platform.isTouch = true
    const scope = createRef<HTMLDivElement>()
    const { container } = render(<><div ref={scope}><div data-hapi-message-role="assistant">First selected words</div></div><SelectedTextQuote scope={scope} /></>)
    expect(screen.queryByRole('toolbar')).toBeNull()
    const node = scope.current!.firstChild!.firstChild!
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 5)
    const readGeometry = vi.fn(() => { throw new Error('Touch actions must not use selection popup coordinates') })
    Object.defineProperty(range, 'getClientRects', { value: readGeometry })
    window.getSelection()!.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    const toolbar = screen.getByRole('toolbar', { name: 'Quote selected text' })
    const button = screen.getByRole('button', { name: 'Quote selected text' })
    expect(container).toContainElement(toolbar)
    expect(scope.current).not.toContainElement(toolbar)
    expect(button.className).not.toContain('fixed')
    expect(button.style.left).toBe('')
    expect(button.style.top).toBe('')
    expect(readGeometry).not.toHaveBeenCalled()
    const nativeMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    fireEvent(node, nativeMenu)
    expect(nativeMenu.defaultPrevented).toBe(false)
    expect(window.getSelection()!.toString()).toBe('First')
    // Dragging the native end handle changes the same selection in place.
    range.setEnd(node, 14)
    fireEvent(document, new Event('selectionchange'))
    expect(screen.getByRole('toolbar')).toBe(toolbar)
    expect(document.activeElement).not.toBe(button)
    fireEvent.pointerDown(button)
    expect(window.getSelection()!.toString()).toBe('First selected')
    fireEvent.click(button)
    expect(setText).toHaveBeenLastCalledWith('Existing draft\n\n> First selected\n\n')
    expect(screen.queryByRole('toolbar')).toBeNull()
})

it('uses Desktop annotations and a verified native item with selection-relative positioning', () => {
    context.metadata = { flavor: 'codex', nativeCodex: {} }
    const scope = createRef<HTMLDivElement>()
    render(<><div ref={scope}><div data-hapi-message-role="assistant"><div data-hapi-response-item-id="real-native-id">Before selected after</div></div></div><SelectedTextQuote scope={scope} /></>)
    const node = scope.current!.querySelector('[data-hapi-response-item-id]')!.firstChild!
    const range = document.createRange()
    range.setStart(node, 7)
    range.setEnd(node, 15)
    Object.defineProperty(range, 'getClientRects', { value: () => [{ left: 180, top: 220, bottom: 244 }] })
    window.getSelection()!.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    const button = screen.getByRole('button', { name: 'Quote selected text' })
    expect(button.style.left).toBe('180px')
    expect(button.style.top).toBe('186px')
    expect(button.className).toContain('text-xs')
    fireEvent.click(button)
    expect(splitResponseAnnotations(setText.mock.calls[0][0])).toEqual({
        body: 'Existing draft',
        annotations: [{ text: 'selected', source: { messageId: 'real-native-id', startOffset: 7, endOffset: 15 } }],
    })
})

it('uses source-free Desktop annotations for runner Codex without inventing item IDs', () => {
    context.metadata = { flavor: 'codex' }
    const scope = createRef<HTMLDivElement>()
    render(<><div ref={scope}><div data-hapi-message-role="assistant">Runner response</div></div><SelectedTextQuote scope={scope} /></>)
    const range = document.createRange()
    range.selectNodeContents(scope.current!.firstChild!)
    window.getSelection()!.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    fireEvent.click(screen.getByRole('button', { name: 'Quote selected text' }))
    expect(splitResponseAnnotations(setText.mock.calls[0][0]).annotations).toEqual([{ text: 'Runner response' }])
})

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
