import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ResponseAnnotationsProvider } from './AssistantChat/ResponseAnnotationReference'

describe('MarkdownRenderer', () => {
    afterEach(() => {
        cleanup()
    })

    it('follows a footnote and its backref in the originating Markdown message without changing the URL', () => {
        const { container } = render(
            <I18nProvider>
                <div data-testid="app-shell" style={{ overflowY: 'auto' }}>
                    <div data-testid="thread-viewport" data-hapi-thread-viewport="true" style={{ overflowY: 'auto' }}>
                        <MarkdownRenderer content={'First[^note:中文].\n\n[^note:中文]: First footnote.'} />
                        <div data-testid="reasoning-scroll" data-hapi-nested-scroll="true" style={{ overflowY: 'auto' }}>
                            <MarkdownRenderer content={'Second[^note:中文].\n\n[^note:中文]: Second footnote.'} />
                        </div>
                    </div>
                </div>
            </I18nProvider>
        )
        const [first, second] = container.querySelectorAll('.aui-md')
        const firstNote = first.querySelector<HTMLElement>('section[data-footnotes] li')!
        const secondNote = second.querySelector<HTMLElement>('section[data-footnotes] li')!
        const ref = second.querySelector<HTMLAnchorElement>('[data-footnote-ref]')!
        const backref = second.querySelector<HTMLAnchorElement>('[data-footnote-backref]')!
        expect(secondNote.id).toBe(firstNote.id)
        const shell = screen.getByTestId('app-shell')
        const viewport = screen.getByTestId('thread-viewport')
        const nested = screen.getByTestId('reasoning-scroll')
        const nestedTop = () => 260 - viewport.scrollTop
        const mockScroller = (element: HTMLElement, top: () => number, height: number) => {
            const scrollTo = vi.fn(({ top }: ScrollToOptions) => { element.scrollTop = top ?? element.scrollTop })
            Object.defineProperties(element, {
                clientHeight: { value: height },
                scrollHeight: { value: 500 },
                scrollTo: { value: scrollTo },
            })
            element.getBoundingClientRect = () => new DOMRect(0, top(), 100, height)
            return scrollTo
        }
        const shellScroll = mockScroller(shell, () => 0, 100)
        const viewportScroll = mockScroller(viewport, () => 100, 100)
        const nestedScroll = mockScroller(nested, nestedTop, 70)
        secondNote.getBoundingClientRect = () => new DOMRect(0, nestedTop() + 100 - nested.scrollTop, 100, 20)
        ref.getBoundingClientRect = () => new DOMRect(0, nestedTop() + 5 - nested.scrollTop, 100, 10)
        const href = window.location.href

        expect(fireEvent.click(ref)).toBe(false)
        expect(document.activeElement).toBe(secondNote)
        expect(nestedScroll).toHaveBeenNthCalledWith(1, { top: 50, behavior: 'instant' })
        expect(viewportScroll).toHaveBeenCalledWith({ top: 130, behavior: 'instant' })
        expect(fireEvent.click(backref)).toBe(false)
        expect(document.activeElement).toBe(ref)
        expect(nestedScroll).toHaveBeenNthCalledWith(2, { top: 5, behavior: 'instant' })
        expect(viewportScroll).toHaveBeenCalledOnce()
        expect(shellScroll).not.toHaveBeenCalled()
        expect(window.location.href).toBe(href)
    })

    it('renders reply annotation references and opens the matching quote and note', async () => {
        const { container } = render(<I18nProvider><ResponseAnnotationsProvider value={[
            { text: 'First selection', annotation: 'First note' },
            { text: 'Second selection', annotation: 'Second note' },
        ]}>
            <MarkdownRenderer content={'Fixed. :codex-annotation{index="1"}:codex-annotation{index="2"}'} />
        </ResponseAnnotationsProvider></I18nProvider>)
        expect(container.textContent).not.toContain(':codex-annotation')
        fireEvent.click(screen.getByRole('button', { name: 'Quote 2' }))
        expect(await screen.findByText('Second selection')).toBeTruthy()
        expect(screen.getByText('Second note')).toBeTruthy()
        expect(screen.queryByText('First selection')).toBeNull()
    })

    it('keeps examples literal and shows an unavailable reference when earlier context is absent', async () => {
        const marker = ':codex-annotation{index="6"}'
        const { container, rerender } = render(<I18nProvider><MarkdownRenderer standalone content={marker} /></I18nProvider>)
        expect(container.textContent).toBe(marker)
        rerender(<I18nProvider><ResponseAnnotationsProvider value={[]}>
            <MarkdownRenderer standalone content={`${marker}\n\n\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\``} />
        </ResponseAnnotationsProvider></I18nProvider>)
        expect(container.querySelector('code')?.textContent).toBe(marker)
        expect(container.querySelector('.aui-md-codeblock')?.textContent).toContain(marker)
        fireEvent.click(screen.getByRole('button', { name: 'Quote 6' }))
        expect(await screen.findByText('The original quote could not be loaded.')).toBeTruthy()
    })

    it('renders fenced code blocks with the shared syntax highlighter shell in standalone mode', () => {
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={'```ts\nexport const ok = true\n```'} />
            </I18nProvider>
        )

        expect(document.querySelector('.aui-md-codeblock')).toBeTruthy()
    })

    it('renders inline code without the fenced-code shell in standalone mode', () => {
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={'Use `npm test` here.'} />
            </I18nProvider>
        )

        expect(document.querySelector('.aui-md-codeblock')).toBeFalsy()
        expect(document.querySelector('.aui-md-code')).toBeTruthy()
    })

    it('renders TeX bracket math in standalone mode', () => {
        const { container } = render(
            <I18nProvider>
                <MarkdownRenderer standalone content={String.raw`\[
E = mc^2
\]`} />
            </I18nProvider>
        )

        expect(container.querySelector('.katex-display')).toBeTruthy()
        expect(container.querySelector('.katex')).toBeTruthy()
        expect(container.textContent).not.toContain('\\[')
    })

    it('renders TeX bracket math through the assistant-ui path', () => {
        const { container } = render(
            <I18nProvider>
                <MarkdownRenderer content={String.raw`Result: \(x^2\)`} />
            </I18nProvider>
        )

        expect(container.querySelector('.katex')).toBeTruthy()
        expect(container.querySelector('.katex-display')).toBeFalsy()
    })
})
