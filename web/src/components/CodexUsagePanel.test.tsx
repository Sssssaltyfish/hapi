import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { normalizeCodexUsage } from '@hapi/protocol/codexUsage'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexUsagePanel } from './CodexUsagePanel'
import { EventMessage } from './AssistantChat/messages/EventMessage'

const snapshot = normalizeCodexUsage({
    summary: { lifetimeTokens: 1_000_000, peakDailyTokens: 200_000, currentStreakDays: 3 },
    dailyUsageBuckets: [{ startDate: '2026-11-04', tokens: 20_000 }],
    threadUsage: { threadId: 'thread', estimatedUsageCreditsMicros: 1_234_567, estimatedUsageUsdMicros: 1_234_500,
        groups: [{ model: 'test-model', reasoningEffort: 'high', speed: 'fast', estimatedUsageCreditsMicros: 1_234_567,
            inputTokens: 150_000, cachedInputTokens: 50_000, netNewInputTokens: 100_000, outputTokens: 50_000, totalTokens: 200_000 }] },
}, { ordinaryUsageAllowed: false, rateLimitsByLimitId: {
    codex: { limitName: 'Codex', planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 60, windowDurationMins: 10080 }, credits: { hasCredits: true, unlimited: false, balance: '9.25' } },
    reviews: { limitName: 'Reviews', primary: { usedPercent: 10 } },
} }, {}, 1_790_000_000_000)

it('renders rich native usage with remaining quota distinct from consumption and no raw response view', () => {
    const { container } = render(<I18nProvider><CodexUsagePanel snapshot={snapshot} /></I18nProvider>)
    expect(screen.getByText('75% remaining')).toBeInTheDocument()
    expect(screen.getByText('40% remaining')).toBeInTheDocument()
    expect(screen.getByText('90% remaining')).toBeInTheDocument()
    expect(screen.getAllByRole('meter')).toHaveLength(3)
    expect(screen.getByText('Included usage')).toBeInTheDocument()
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText('9.25')).toBeInTheDocument()
    expect(screen.getByText('$1.23')).toBeInTheDocument()
    expect(screen.getByText('Lifetime tokens consumed')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Consumption by model and reasoning'))
    expect(screen.getByText('test-model · high · fast')).toBeInTheDocument()
    expect(screen.getByText('Total tokens consumed')).toBeInTheDocument()
    expect(screen.queryByText(/750,000/)).not.toBeInTheDocument()
    expect(container.querySelector('pre, code')).toBeNull()
    expect(container.textContent).not.toContain('rateLimitsByLimitId')
})

it('uses the same structured view for a Runner event and keeps malformed attachments readable', () => {
    const { rerender, container } = render(<I18nProvider><EventMessage event={{ type: 'message', message: 'Usage report', codexUsage: snapshot }} /></I18nProvider>)
    expect(screen.getByText('75% remaining')).toBeInTheDocument()
    expect(screen.queryByText('Usage report')).not.toBeInTheDocument()
    expect(container.querySelector('pre, code')).toBeNull()
    rerender(<I18nProvider><EventMessage event={{ type: 'message', message: 'Usage unavailable', codexUsage: { limits: 'invalid' } }} /></I18nProvider>)
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument()
    expect(container.textContent).not.toContain('invalid')
})

it('formats small nonzero costs with their units without changing the snapshot', () => {
    const tiny = { ...snapshot, thread: { ...snapshot.thread!, creditsMicros: '1', usdMicros: '1', groups: [] } }
    render(<I18nProvider><CodexUsagePanel snapshot={tiny} /></I18nProvider>)
    expect(screen.getByText('<$0.01')).toBeInTheDocument()
    expect(screen.getByText('<0.01')).toBeInTheDocument()
    expect(tiny.thread.usdMicros).toBe('1')
})

it('uses complete 24-hour timestamps and identifies the browser timezone', () => {
    const { container } = render(<I18nProvider><CodexUsagePanel snapshot={snapshot} /></I18nProvider>)
    const times = [...container.querySelectorAll('time')]
    expect(times.length).toBeGreaterThan(1)
    for (const time of times) {
        expect(time.textContent).toMatch(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):\d{2}:\d{2}$/)
        expect(time).toHaveClass('whitespace-nowrap')
        expect(time.title).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
        expect(Number.isFinite(new Date(time.dateTime).getTime())).toBe(true)
    }
    expect(screen.getByText(`(${Intl.DateTimeFormat().resolvedOptions().timeZone})`)).toBeInTheDocument()
})

it('omits routine limit states and retains explicit unlimited credits and reached spending', () => {
    const normal = { ...snapshot, limits: [{ ...snapshot.limits[0], spendControlReached: false }] }
    const { rerender } = render(<I18nProvider><CodexUsagePanel snapshot={normal} /></I18nProvider>)
    expect(screen.queryByText('Limited credits')).not.toBeInTheDocument()
    expect(screen.queryByText('Not reached')).not.toBeInTheDocument()
    expect(screen.queryByText('Spending control')).not.toBeInTheDocument()
    const exceptional = { ...normal, limits: [{ ...normal.limits[0], spendControlReached: true,
        credits: { available: true, balance: null, unlimited: true } }] }
    rerender(<I18nProvider><CodexUsagePanel snapshot={exceptional} /></I18nProvider>)
    expect(screen.getByText('Unlimited credits')).toBeInTheDocument()
    expect(screen.getByText('Reached')).toBeInTheDocument()
})
