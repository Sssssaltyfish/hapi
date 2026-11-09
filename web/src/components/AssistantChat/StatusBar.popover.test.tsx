import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

describe('StatusBar context occupancy', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('keeps stable connection labels in English and offsets the whole left status', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        const { rerender } = render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} />
            </I18nProvider>
        )

        const onlineLabel = screen.getByText('online')
        expect(onlineLabel.className.split(' ')).not.toContain('top-px')
        expect(onlineLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(onlineLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(onlineLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')

        rerender(
            <I18nProvider>
                <StatusBar active={false} thinking={false} agentState={null} />
            </I18nProvider>
        )

        const offlineLabel = screen.getByText('offline')
        expect(offlineLabel.className.split(' ')).toContain('text-[#999]')
        expect(offlineLabel.className.split(' ')).not.toContain('top-px')
        expect(offlineLabel.previousElementSibling?.className.split(' ')).toContain('bg-[#999]')
        expect(offlineLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(offlineLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(offlineLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')

        rerender(
            <I18nProvider>
                <StatusBar active thinking agentState={null} />
            </I18nProvider>
        )

        const thinkingLabel = screen.getByText(/…$/)
        expect(thinkingLabel.className.split(' ')).not.toContain('top-px')
        expect(thinkingLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(thinkingLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(thinkingLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')
    })

    it('uses an effort-only reasoning label on mobile and the full label on desktop', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    modelReasoningEffort="xhigh"
                    effort="max"
                />
            </I18nProvider>
        )

        expect(screen.getByText('xhigh').className.split(' ')).toContain('sm:hidden')
        const desktopLabel = screen.getByText('reasoning xhigh')
        expect(desktopLabel.className.split(' ')).toContain('hidden')
        expect(desktopLabel.className.split(' ')).toContain('sm:inline')
    })

    it('keeps the Codex default reasoning label when model effort is absent', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    modelReasoningEffort={null}
                />
            </I18nProvider>
        )

        expect(screen.getByText('default').className.split(' ')).toContain('sm:hidden')
        expect(screen.getByText('reasoning default').className.split(' ')).toContain('sm:inline')
    })

    it('uses Pi ordinary effort instead of model reasoning effort', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="pi"
                    modelReasoningEffort="xhigh"
                    effort="max"
                />
            </I18nProvider>
        )

        expect(screen.getByText('max').className.split(' ')).toContain('sm:hidden')
        expect(screen.getByText('reasoning max').className.split(' ')).toContain('sm:inline')
        expect(screen.queryByText('reasoning xhigh')).not.toBeInTheDocument()
    })

    it('hides Pi reasoning when effort is absent or blank', () => {
        const { rerender } = render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="pi"
                />
            </I18nProvider>
        )

        expect(screen.queryByText('reasoning default')).not.toBeInTheDocument()
        expect(screen.queryByText('default')).not.toBeInTheDocument()

        rerender(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="pi"
                    effort="   "
                />
            </I18nProvider>
        )

        expect(screen.queryByText('reasoning default')).not.toBeInTheDocument()
        expect(screen.queryByText('default')).not.toBeInTheDocument()
    })

    it.each(['agy', 'claude', 'grok'])('shows %s ordinary effort beside its current approval mode', agentFlavor => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor={agentFlavor}
                    effort="high"
                    permissionMode={agentFlavor === 'agy' ? 'request-review' : 'default'}
                />
            </I18nProvider>
        )

        expect(screen.getByText('high').className.split(' ')).toContain('sm:hidden')
        expect(screen.getByText('reasoning high')).toBeInTheDocument()
        expect(screen.getByText(agentFlavor === 'agy' ? 'Request Review' : 'Default')).toBeInTheDocument()
    })

    it('shows the running DSH effort and approval labels without translating opaque values', () => {
        render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} agentFlavor="dsh"
                    sessionReasoningLabel="Deep" sessionPermissionLabel="Ask on write" />
            </I18nProvider>
        )
        expect(screen.getByText('Deep').className.split(' ')).toContain('sm:hidden')
        expect(screen.getByText('reasoning Deep')).toBeInTheDocument()
        expect(screen.getByText('Ask on write')).toBeInTheDocument()
    })

    it('does not claim effort or approval modes for unsupported sessions', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="unknown"
                    effort="max"
                    permissionMode="default"
                    permissionModeOptions={[]}
                />
            </I18nProvider>
        )

        expect(screen.queryByText('reasoning max')).not.toBeInTheDocument()
        expect(screen.queryByText('max')).not.toBeInTheDocument()
        expect(screen.queryByText('Default')).not.toBeInTheDocument()
    })

    it('toggles actual occupancy beside effort on the same status row', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    contextSize={90_000}
                    contextWindow={258_000}
                    agentFlavor="codex"
                    modelReasoningEffort="xhigh"
                />
            </I18nProvider>
        )

        const connectionLabel = screen.getByText('online')
        const leftStatusGroup = connectionLabel.parentElement?.parentElement
        const statusBar = leftStatusGroup?.parentElement
        const rightStatusGroup = statusBar?.lastElementChild
        expect(statusBar?.className.split(' ')).toContain('items-baseline')
        expect(leftStatusGroup?.className.split(' ')).toContain('items-baseline')
        expect(rightStatusGroup?.className.split(' ')).toContain('items-baseline')
        expect(connectionLabel.className.split(' ')).not.toContain('top-px')
        expect(connectionLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(connectionLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(connectionLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')
        expect(leftStatusGroup?.className.split(' ')).toContain('gap-2')
        expect(leftStatusGroup?.className.split(' ')).not.toContain('sm:gap-3')
        expect(rightStatusGroup?.className.split(' ')).toContain('gap-2')

        const trigger = screen.getByRole('button', { name: '上下文详情' })
        expect(trigger.className.split(' ')).not.toContain('relative')
        expect(trigger.className.split(' ')).not.toContain('-top-px')
        expect(trigger.className.split(' ')).toContain('text-xs')
        expect(trigger.className.split(' ')).toContain('text-[var(--app-hint)]')
        expect(trigger.textContent).toBe('ctx 35%')
        expect(rightStatusGroup).toContainElement(trigger)
        expect(rightStatusGroup).toContainElement(screen.getByText('xhigh'))
        expect(trigger).toHaveAttribute('aria-pressed', 'false')
        expect(trigger.className.split(' ')).not.toContain('hidden')
        fireEvent.click(trigger)
        expect(trigger.textContent).toBe('ctx 90k / 258k')
        expect(trigger).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(trigger)
        expect(trigger.textContent).toBe('ctx 35%')
    })

    it('does not invent a window from the model when only usage is known', () => {
        localStorage.setItem('hapi-lang', 'en')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    contextSize={90_000}
                    agentFlavor="codex"
                    model="gpt-6.1-sol"
                />
            </I18nProvider>
        )

        expect(screen.queryByRole('button', { name: 'Context details' })).not.toBeInTheDocument()
        expect(screen.queryByText(/ctx/)).not.toBeInTheDocument()
    })
})
