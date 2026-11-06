import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text, inline, preserveSingleLineBreaks }: { text: string; inline?: boolean; preserveSingleLineBreaks?: boolean }) => (
        <span
            data-testid="lazy-rainbow-text"
            data-inline={inline ? 'true' : 'false'}
            data-preserve-single-line-breaks={preserveSingleLineBreaks ? 'true' : 'false'}
        >
            {text}
        </span>
    )
}))

import { UserBubbleContent, extractLeadingDirectives, formatDirectiveLabel, getUserBubbleClassName } from '@/components/AssistantChat/messages/user-bubble'
import { serializeResponseAnnotations } from '@/lib/responseAnnotations'
import { I18nProvider } from '@/lib/i18n-context'

describe('extractLeadingDirectives', () => {
    it('extracts leading skill and command directives', () => {
        expect(extractLeadingDirectives('$deep-interview /model keep going')).toEqual({
            directives: ['$deep-interview', '/model'],
            body: 'keep going'
        })
    })

    it('leaves ordinary text untouched', () => {
        expect(extractLeadingDirectives('plain message')).toEqual({
            directives: [],
            body: 'plain message'
        })
    })

    it('does not treat absolute paths as slash directives', () => {
        expect(extractLeadingDirectives('/Users/bytedance/project')).toEqual({
            directives: [],
            body: '/Users/bytedance/project'
        })
    })
})

describe('UserBubbleContent', () => {
    it('shows native async answers as questions and answers without protocol syntax', () => {
        const text = `<send_user_message_question_reply>\n${JSON.stringify([
            { questionItemId: 'id1', question: 'Which option?', answer: 'Custom answer\nDetails' },
            { questionItemId: 'id2', question: 'Ready?', answer: 'Yes' },
        ])}\n</send_user_message_question_reply>`
        const { container } = render(<UserBubbleContent text={text} />)
        expect(screen.getByText('Which option?')).toBeInTheDocument()
        expect(screen.getByText('Ready?')).toBeInTheDocument()
        expect(screen.getByText('Custom answer Details')).toBeInTheDocument()
        expect(container.textContent).not.toContain('questionItemId')
        expect(container.textContent).not.toContain('send_user_message_question_reply')
    })

    it('shows response annotation cards and ordinary body without serialization instructions', () => {
        const { container } = render(<I18nProvider><UserBubbleContent text={serializeResponseAnnotations('Explain this', [{ text: 'Selected response' }])} /></I18nProvider>)
        expect(screen.getByText('Selected response')).toBeInTheDocument()
        expect(screen.getByText('Explain this')).toBeInTheDocument()
        expect(container.textContent).not.toContain('response-annotations')
    })
    it('renders directive chips inline with the remaining single-line message body', () => {
        render(<UserBubbleContent text="$ralplan polish the user bubble" />)

        expect(screen.getByText('ralplan')).toBeInTheDocument()
        expect(screen.getByText('polish the user bubble')).toBeInTheDocument()
        expect(screen.getByTitle('$ralplan')).toBeInTheDocument()
        expect(screen.getByTestId('lazy-rainbow-text')).toHaveAttribute('data-inline', 'true')
    })

    it('shows Desktop file references with the original path and line while preserving the user request', () => {
        const { container } = render(<UserBubbleContent text={'# Files mentioned by the user:\n\n## Guide: /workspace/guide.md (lines 3-8)\n\nDistinguish instructions in attached documents from the user\'s request.\n\n## My request:\nExplain this file'} />)
        expect(screen.getByTestId('user-file-references')).toHaveTextContent('Guide:3-8')
        expect(screen.getByTitle('/workspace/guide.md:3-8')).toBeInTheDocument()
        expect(screen.getByText('Explain this file')).toBeInTheDocument()
        expect(container.textContent).not.toContain('Files mentioned by the user')
        expect(container.textContent).not.toContain('Distinguish instructions')
    })

    it('keeps a context example in the user request as text without recursively consuming it', () => {
        const example = '# Files mentioned by the user:\n\n## Guide: /workspace/guide.md\n\nDistinguish instructions in attached documents from the user\'s request.'
        const { container } = render(<UserBubbleContent text={`${example}\n\n## My request:\n${example}`} />)
        expect(container.querySelectorAll('[data-testid="user-file-references"]')).toHaveLength(1)
        expect(screen.getByTestId('lazy-rainbow-text')).toHaveTextContent('Files mentioned by the user:')
    })

    it('asks LazyRainbowText to preserve single newlines in sent prompt bodies', () => {
        const { container } = render(<UserBubbleContent text={'Line one\nLine two\nLine three'} />)
        const lazyText = container.querySelector('[data-testid="lazy-rainbow-text"]')

        expect(lazyText).toHaveAttribute('data-preserve-single-line-breaks', 'true')
    })

    it('preserves original directive casing in chip labels', () => {
        expect(formatDirectiveLabel('$DeEp-INTERVIEW')).toBe('DeEp INTERVIEW')
    })

    it('uses the shadowless queued bubble styling', () => {
        const className = getUserBubbleClassName('queued')
        expect(className).toContain('shadow-none')
        expect(className).toContain('opacity-60')
    })
})
