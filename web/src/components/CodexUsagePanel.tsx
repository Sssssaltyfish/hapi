import type { ReactNode } from 'react'
import { codexMicroAmount, type CodexUsageLimit, type CodexUsageSnapshot, type CodexUsageWindow } from '@hapi/protocol/codexUsage'
import { useTranslation } from '@/lib/use-translation'

function count(value: string | null): string | null {
    if (value === null) return null
    try { return BigInt(value).toLocaleString() }
    catch { return value }
}

function decimal(value: string): string {
    const [whole, fraction] = value.split('.')
    const integer = /^\d+$/.test(whole) ? count(whole) : whole
    return `${integer}${fraction ? `.${fraction}` : ''}`
}

function date(value: number | null, seconds = true): ReactNode {
    if (value === null) return null
    const parsed = new Date(value * (seconds ? 1000 : 1))
    if (!Number.isFinite(parsed.getTime())) return null
    return <time dateTime={parsed.toISOString()}>{parsed.toLocaleString()}</time>
}

function Rows({ values }: { values: Array<[string, ReactNode]> }) {
    return <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {values.filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => <div key={label} className="contents">
            <dt className="text-[var(--app-hint)]">{label}</dt>
            <dd className="break-words text-right tabular-nums">{value}</dd>
        </div>)}
    </dl>
}

function Window({ value, label }: { value: CodexUsageWindow; label: string }) {
    const { t } = useTranslation()
    const percent = (number: number) => number.toLocaleString(undefined, { maximumFractionDigits: 2 })
    const duration = value.durationMins
    const windowLabel = duration === null ? label : `${label} · ${duration >= 1440 && duration % 1440 === 0
        ? t('codexUsage.days', { count: duration / 1440 })
        : duration >= 60 && duration % 60 === 0 ? t('codexUsage.hours', { count: duration / 60 })
            : t('codexUsage.minutes', { count: duration })}`
    return <div className="rounded-md bg-[var(--app-bg)] p-3" aria-label={windowLabel}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h4 className="text-sm font-medium">{windowLabel}</h4>
            <p className="text-base font-semibold tabular-nums">{value.remainingPercent === null
                ? t('codexUsage.remainingUnknown') : t('codexUsage.percentRemaining', { value: percent(value.remainingPercent) })}</p>
        </div>
        {value.remainingPercent !== null && <div className="my-2 h-1.5 overflow-hidden rounded bg-[var(--app-divider)]" role="meter"
            aria-label={t('codexUsage.remainingAllowance')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value.remainingPercent}>
            <div className="h-full rounded bg-[var(--app-link)]" style={{ width: `${value.remainingPercent}%` }} />
        </div>}
        <Rows values={[
            [t('codexUsage.resets'), date(value.resetsAt) ?? t('codexUsage.unknown')],
        ]} />
    </div>
}

function Limit({ value }: { value: CodexUsageLimit }) {
    const { t } = useTranslation()
    const reasons: Record<string, string> = {
        rate_limit_reached: t('codexUsage.reason.rate'),
        workspace_owner_credits_depleted: t('codexUsage.reason.ownerCredits'),
        workspace_member_credits_depleted: t('codexUsage.reason.memberCredits'),
        workspace_owner_usage_limit_reached: t('codexUsage.reason.ownerUsage'),
        workspace_member_usage_limit_reached: t('codexUsage.reason.memberUsage'),
    }
    const credits = value.credits
    const spending = value.spending
    return <section className="space-y-3 rounded-lg border p-3">
        <div className="flex flex-wrap justify-between gap-2">
            <h3 className="font-medium">{value.name ?? value.id ?? t('codexUsage.allowance')}</h3>
            {value.plan && <span className="rounded bg-[var(--app-bg)] px-2 py-0.5 text-xs">{t('codexUsage.plan')}: {value.plan.replace(/_/g, ' ')}</span>}
        </div>
        {value.model && <p className="break-all text-xs text-[var(--app-hint)]">{t('codexUsage.model')}: {value.model}</p>}
        {value.primary && <Window value={value.primary} label={t('codexUsage.primary')} />}
        {value.secondary && <Window value={value.secondary} label={t('codexUsage.secondary')} />}
        {!value.primary && !value.secondary && <p className="text-sm text-[var(--app-hint)]">{t('codexUsage.remainingUnknown')}</p>}
        {value.reachedReason && <p className="text-sm">{reasons[value.reachedReason] ?? t('codexUsage.limitReported')}</p>}
        {credits && <div className="space-y-2 border-t pt-2">
            <h4 className="text-sm font-medium">{t('codexUsage.credits')}</h4>
            <Rows values={[
                [t('codexUsage.creditBalance'), credits.balance === null ? null : decimal(credits.balance)],
                [t('codexUsage.creditAvailability'), credits.available === null ? null : credits.available ? t('codexUsage.available') : t('codexUsage.noCredits')],
                [t('codexUsage.creditLimit'), credits.unlimited === null ? null : credits.unlimited ? t('codexUsage.unlimitedCredits') : t('codexUsage.limitedCredits')],
            ]} />
        </div>}
        {(spending || value.spendControlReached !== null) && <div className="space-y-2 border-t pt-2">
            <h4 className="text-sm font-medium">{t('codexUsage.spending')}</h4>
            <Rows values={[
                [t('codexUsage.remaining'), spending?.remainingPercent == null ? null : `${spending.remainingPercent.toLocaleString()}%`],
                [t('codexUsage.spent'), spending?.used ?? null],
                [t('codexUsage.spendingLimit'), spending?.limit ?? null],
                [t('codexUsage.resets'), date(spending?.resetsAt ?? null)],
                [t('codexUsage.spendingStatus'), value.spendControlReached === null ? null
                    : value.spendControlReached ? t('codexUsage.reached') : t('codexUsage.notReached')],
            ]} />
        </div>}
    </section>
}

export function CodexUsagePanel({ snapshot }: { snapshot: CodexUsageSnapshot }) {
    const { t } = useTranslation()
    const summary = snapshot.summary
    const thread = snapshot.thread
    return <div className="space-y-3 text-left text-[var(--app-fg)]" aria-label={t('codexUsage.title')}>
        <div>
            <h2 className="font-semibold">{t('codexUsage.title')}</h2>
            <p className="mt-1 text-xs text-[var(--app-hint)]">{t('codexUsage.snapshotAt')} {date(snapshot.readAt, false)}</p>
        </div>
        <p className="text-sm">{snapshot.ordinaryUsageAllowed === null ? t('codexUsage.permissionUnknown')
            : snapshot.ordinaryUsageAllowed ? t('codexUsage.permissionAllowed') : t('codexUsage.permissionBlocked')}</p>
        {snapshot.limits.map((value, index) => <Limit key={value.id ?? index} value={value} />)}
        {snapshot.limits.length > 0 && <p className="text-xs text-[var(--app-hint)]">{t('codexUsage.percentNote')}</p>}
        {snapshot.unavailable.rateLimits && <p className="whitespace-pre-wrap text-sm text-[var(--app-hint)]">{t('codexUsage.limitsUnavailable')} {snapshot.unavailable.rateLimits}</p>}
        {snapshot.resetCredits && <section className="space-y-2 rounded-lg border p-3">
            <h3 className="text-sm font-medium">{t('codexUsage.resetCredits')}</h3>
            <Rows values={[[t('codexUsage.availableResets'), count(snapshot.resetCredits.available) ?? t('codexUsage.unknown')]]} />
            {snapshot.resetCredits.credits?.length ? <details>
                <summary className="cursor-pointer text-sm">{t('codexUsage.resetDetails')}</summary>
                <div className="mt-2 space-y-3">{snapshot.resetCredits.credits.map(credit => <div key={credit.id}>
                    {credit.title && <p className="text-sm font-medium">{credit.title}</p>}
                    {credit.description && <p className="mb-1 text-sm">{credit.description}</p>}
                    <Rows values={[[t('codexUsage.granted'), date(credit.grantedAt)], [t('codexUsage.expires'), date(credit.expiresAt)]]} />
                </div>)}</div>
            </details> : null}
        </section>}
        {thread && <section className="space-y-2 rounded-lg border p-3">
            <h3 className="text-sm font-medium">{t('codexUsage.threadConsumption')}</h3>
            <Rows values={[
                [t('codexUsage.estimatedCredits'), thread.creditsMicros === null ? t('codexUsage.unknown') : decimal(codexMicroAmount(thread.creditsMicros))],
                [t('codexUsage.estimatedUsd'), thread.usdMicros === null ? null : `$${decimal(codexMicroAmount(thread.usdMicros))}`],
            ]} />
            <p className="text-xs text-[var(--app-hint)]">{t('codexUsage.estimateNote')}</p>
            {thread.groups.length > 0 && <details>
                <summary className="cursor-pointer text-sm">{t('codexUsage.modelBreakdown')}</summary>
                <div className="mt-2 space-y-3">{thread.groups.map((group, index) => <div key={index} className="rounded-md bg-[var(--app-bg)] p-2">
                    <p className="mb-2 break-words text-sm font-medium">{[group.model, group.reasoning, group.speed].filter(Boolean).join(' · ') || t('codexUsage.modelUnknown')}</p>
                    <Rows values={[
                        [t('codexUsage.estimatedCredits'), group.creditsMicros === null ? null : decimal(codexMicroAmount(group.creditsMicros))],
                        [t('codexUsage.inputTokens'), count(group.inputTokens)],
                        [t('codexUsage.newInputTokens'), count(group.newInputTokens)],
                        [t('codexUsage.cachedInputTokens'), count(group.cachedInputTokens)],
                        [t('codexUsage.outputTokens'), count(group.outputTokens)],
                        [t('codexUsage.totalTokens'), count(group.totalTokens)],
                    ]} />
                </div>)}</div>
            </details>}
        </section>}
        {summary && <section className="space-y-2 rounded-lg border p-3">
            <h3 className="text-sm font-medium">{t('codexUsage.accountActivity')}</h3>
            <Rows values={[
                [t('codexUsage.lifetimeTokens'), count(summary.lifetimeTokens)],
                [t('codexUsage.peakDailyTokens'), count(summary.peakDailyTokens)],
                [t('codexUsage.longestTurn'), summary.longestTurnSeconds === null ? null : t('codexUsage.seconds', { count: count(summary.longestTurnSeconds)! })],
                [t('codexUsage.currentStreak'), summary.currentStreakDays === null ? null : t('codexUsage.days', { count: count(summary.currentStreakDays)! })],
                [t('codexUsage.longestStreak'), summary.longestStreakDays === null ? null : t('codexUsage.days', { count: count(summary.longestStreakDays)! })],
            ]} />
        </section>}
        {snapshot.daily?.length ? <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer">{t('codexUsage.dailyConsumption')}</summary>
            <div className="mt-2 max-h-64 overflow-y-auto"><Rows values={[...snapshot.daily].sort((a, b) => b.date.localeCompare(a.date)).map(day => [day.date, count(day.tokens)])} /></div>
        </details> : null}
        {snapshot.unavailable.usage && <p className="whitespace-pre-wrap text-sm text-[var(--app-hint)]">{t('codexUsage.usageUnavailable')} {snapshot.unavailable.usage}</p>}
    </div>
}
