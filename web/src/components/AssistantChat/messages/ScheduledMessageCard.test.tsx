import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ScheduledMessageCard } from './ScheduledMessageCard'

vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))

it('starts scheduled instructions folded and keeps the result readable', () => {
    const view = render(<I18nProvider><ScheduledMessageCard message={{ kind: 'trigger', automationId: 'daily', time: '2026-11-01T00:59:27.543Z', text: 'Check the hosts' }} /></I18nProvider>)
    expect(view.container.querySelector('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Check the hosts')).toBeInTheDocument()
    view.rerender(<I18nProvider><ScheduledMessageCard message={{ kind: 'result', automationId: 'daily', decision: 'DONT_NOTIFY', text: 'Both hosts are unchanged.' }} /></I18nProvider>)
    expect(screen.getByText('Both hosts are unchanged.')).toBeVisible()
    expect(view.container.textContent).not.toContain('DONT_NOTIFY')
    expect(view.container.querySelector('details')).toBeNull()
})
