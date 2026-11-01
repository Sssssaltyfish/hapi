import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ResponseAnnotationsProvider } from './AssistantChat/ResponseAnnotationReference'

describe('MarkdownRenderer', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders reply annotation references and opens the matching quote and note', () => {
        const { container } = render(<I18nProvider><ResponseAnnotationsProvider value={[
            { text: 'First selection', annotation: 'First note' },
            { text: 'Second selection', annotation: 'Second note' },
        ]}>
            <MarkdownRenderer content={'Fixed. :codex-annotation{index="1"}:codex-annotation{index="2"}'} />
        </ResponseAnnotationsProvider></I18nProvider>)
        expect(container.textContent).not.toContain(':codex-annotation')
        fireEvent.click(screen.getByRole('button', { name: 'Quote 2' }))
        expect(screen.getByText('Second selection')).toBeTruthy()
        expect(screen.getByText('Second note')).toBeTruthy()
        expect(screen.queryByText('First selection')).toBeNull()
    })

    it('keeps examples literal and shows an unavailable reference when earlier context is absent', () => {
        const marker = ':codex-annotation{index="6"}'
        const { container, rerender } = render(<I18nProvider><MarkdownRenderer standalone content={marker} /></I18nProvider>)
        expect(container.textContent).toBe(marker)
        rerender(<I18nProvider><ResponseAnnotationsProvider value={[]}>
            <MarkdownRenderer standalone content={`${marker}\n\n\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\``} />
        </ResponseAnnotationsProvider></I18nProvider>)
        expect(container.querySelector('code')?.textContent).toBe(marker)
        expect(container.querySelector('.aui-md-codeblock')?.textContent).toContain(marker)
        fireEvent.click(screen.getByRole('button', { name: 'Quote 6' }))
        expect(screen.getByText('The original quote could not be loaded.')).toBeTruthy()
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
