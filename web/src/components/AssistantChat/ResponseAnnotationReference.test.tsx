import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResponseAnnotationReference, ResponseAnnotationsProvider } from './ResponseAnnotationReference'

const { navigate, readAnnotations } = vi.hoisted(() => ({ navigate: vi.fn(), readAnnotations: vi.fn() }))
vi.mock('./ResponseAnnotationSession', () => ({ useResponseAnnotationSession: () => ({ navigate, resolver: { readAnnotations } }) }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => vi.clearAllMocks())

it('places the quote once its content is ready instead of resizing a loading popover', async () => {
    let resolve!: (value: { text: string }[]) => void
    readAnnotations.mockReturnValue(new Promise(done => { resolve = done }))
    render(<ResponseAnnotationsProvider value={{ annotations: [], partId: 'reply-part' }}>
        <ResponseAnnotationReference index={1}>directive</ResponseAnnotationReference>
    </ResponseAnnotationsProvider>)
    const trigger = screen.getByRole('button', { name: 'message.quoteReference' })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => resolve([{ text: 'The complete original quote' }]))
    expect(await screen.findByRole('dialog')).toHaveTextContent('The complete original quote')
})

it.each(['escape', 'outside click'])('does not open a delayed quote after %s', async action => {
    let resolve!: (value: { text: string }[]) => void
    readAnnotations.mockReturnValue(new Promise(done => { resolve = done }))
    render(<ResponseAnnotationsProvider value={{ annotations: [], partId: 'reply-part' }}>
        <ResponseAnnotationReference index={1}>directive</ResponseAnnotationReference>
    </ResponseAnnotationsProvider>)
    const trigger = screen.getByRole('button', { name: 'message.quoteReference' })
    fireEvent.click(trigger)
    if (action === 'escape') fireEvent.keyDown(trigger, { key: 'Escape' })
    else fireEvent.pointerDown(document.body)
    await act(async () => resolve([{ text: 'A cancelled lookup' }]))
    expect(screen.queryByRole('dialog')).toBeNull()
})

function openReference() {
    render(<><button data-testid="original">Original source</button><ResponseAnnotationsProvider value={[{ text: 'quoted text', source: { messageId: 'source', startOffset: 0, endOffset: 11 } }]}>
        <ResponseAnnotationReference index={1}>directive</ResponseAnnotationReference>
    </ResponseAnnotationsProvider></>)
    const trigger = screen.getByRole('button', { name: 'message.quoteReference' })
    trigger.focus()
    fireEvent.click(trigger)
    return trigger
}

it('keeps a quote jump from restoring focus to the old offscreen reference trigger', async () => {
    const trigger = openReference()
    navigate.mockImplementation(async () => { screen.getByTestId('original').focus({ preventScroll: true }) })
    fireEvent.click(await screen.findByRole('button', { name: 'message.quoteOriginal' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Radix close autofocus runs after the content unmount. Allow that task to
    // execute, rather than passing before its default trigger restoration.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(navigate).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(screen.getByTestId('original'))
    expect(document.activeElement).not.toBe(trigger)
})

it('still restores trigger focus when the reference is dismissed without a jump', async () => {
    const trigger = openReference()
    await screen.findByRole('button', { name: 'message.quoteOriginal' })
    screen.getByRole('button', { name: 'message.quoteOriginal' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(navigate).not.toHaveBeenCalled()
})
