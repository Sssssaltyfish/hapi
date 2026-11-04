import type { ReactNode } from 'react'
import { codexMicroAmount, type CodexUsageLimit, type CodexUsageSnapshot, type CodexUsageWindow } from '@hapi/protocol/codexUsage'
import { useTranslation } from '@/lib/use-translation'
import { commandNumber } from '@hapi/protocol/commandNumber'

function count(value: string | null): string | null {
    if (value === null) return null
    return commandNumber(value)
}

function decimal(value: string): string {
    return commandNumber(value)
}

function date(value: number | null, seconds = true): ReactNode {
    if (value === null) return null
    const parsed = new Date(value * (seconds ? 1000 : 1))
    if (!Number.isFinite(parsed.getTime())) return null
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(parsed)
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value ?? ''
    const formatted = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
    return <time className="inline-block whitespace-nowrap" dateTime={parsed.toISOString()} title={zone}>{formatted}</time>
}

function Rows({ values }: { values: Array<[string, ReactNode]> }) {
    return <dl className="space-y-1.5 text-sm">
        {values.filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <dt className="min-w-0 text-[var(--app-hint)]">{label}</dt>
            <dd className="ml-auto min-w-0 max-w-full break-words text-right tabular-nums">{value}</dd>
        </div>)}
    </dl>
}

function Window({ value, label }: { value: CodexUsageWindow; label: string }) {
    const { t } = useTranslation()
    const percent = (number: number) => commandNumber(number)
    const duration = value.durationMins
    const windowLabel = duration === null ? label : `${label} · ${duration >= 1440 && duration % 1440 === 0
        ? t('codexUsage.days', { count: commandNumber(duration / 1440) })
        : duration >= 60 && duration % 60 === 0 ? t('codexUsage.hours', { count: commandNumber(duration / 60) })
            : t('codexUsage.minutes', { count: commandNumber(duration) })}`
    return <div className="space-y-2" aria-label={windowLabel}>
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
            [t('codexUsage.resets'), date(value.resetsAt)],
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
    const showCreditAvailability = credits?.available !== null && credits?.available !== undefined
        && (credits.available === false || (credits.balance === null && credits.unlimited !== true))
    const hasCredits = credits && (credits.balance !== null || showCreditAvailability || credits.unlimited === true)
    const hasSpending = spending && Object.values(spending).some(value => value !== null)
    return <section className="space-y-3">
        <div className="flex flex-wrap justify-between gap-2">
            <h3 className="font-medium">{value.name ?? value.id ?? t('codexUsage.allowance')}</h3>
            {value.plan && <span className="rounded bg-[var(--app-bg)] px-2 py-0.5 text-xs">{t('codexUsage.plan')}: {value.plan.replace(/_/g, ' ')}</span>}
        </div>
        {value.model && <p className="break-all text-xs text-[var(--app-hint)]">{t('codexUsage.model')}: {value.model}</p>}
        {value.primary && <Window value={value.primary} label={t('codexUsage.primary')} />}
        {value.secondary && <Window value={value.secondary} label={t('codexUsage.secondary')} />}
        {!value.primary && !value.secondary && <p className="text-sm text-[var(--app-hint)]">{t('codexUsage.remainingUnknown')}</p>}
        {value.reachedReason && <p className="text-sm">{reasons[value.reachedReason] ?? t('codexUsage.limitReported')}</p>}
        {credits && hasCredits && <div className="space-y-2 pt-2">
            <h4 className="text-sm font-medium">{t('codexUsage.credits')}</h4>
            <Rows values={[
                [t('codexUsage.creditBalance'), credits.balance === null ? null : decimal(credits.balance)],
                [t('codexUsage.creditAvailability'), !showCreditAvailability ? null : credits.available ? t('codexUsage.available') : t('codexUsage.noCredits')],
                [t('codexUsage.creditLimit'), credits.unlimited === true ? t('codexUsage.unlimitedCredits') : null],
            ]} />
        </div>}
        {(hasSpending || value.spendControlReached === true) && <div className="space-y-2 pt-2">
            <h4 className="text-sm font-medium">{t('codexUsage.spending')}</h4>
            <Rows values={[
                [t('codexUsage.remaining'), spending?.remainingPercent == null ? null : commandNumber(spending.remainingPercent, { suffix: '%' })],
                [t('codexUsage.spent'), spending?.used == null ? null : decimal(spending.used)],
                [t('codexUsage.spendingLimit'), spending?.limit == null ? null : decimal(spending.limit)],
                [t('codexUsage.resets'), date(spending?.resetsAt ?? null)],
                [t('codexUsage.spendingStatus'), value.spendControlReached === true ? t('codexUsage.reached') : null],
            ]} />
        </div>}
    </section>
}

export function CodexUsagePanel({ snapshot }: { snapshot: CodexUsageSnapshot }) {
    const { t } = useTranslation()
    const summary = snapshot.summary
    const thread = snapshot.thread
    const hasSummary = summary && Object.values(summary).some(value => value !== null)
    const hasThread = thread && (thread.creditsMicros !== null || thread.usdMicros !== null || thread.groups.length > 0)
    const hasUsage = snapshot.ordinaryUsageAllowed !== null || snapshot.limits.length > 0 || snapshot.resetCredits
        || hasSummary || hasThread || snapshot.daily?.length || Object.values(snapshot.unavailable).some(Boolean)
    return <div className="space-y-3 text-left text-[var(--app-fg)]" aria-label={t('codexUsage.title')}>
        <div>
            <h2 className="font-semibold">{t('codexUsage.title')}</h2>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-1 gap-y-1 text-xs text-[var(--app-hint)]"><span>{t('codexUsage.snapshotAt')}</span> {date(snapshot.readAt, false)} <span>({Intl.DateTimeFormat().resolvedOptions().timeZone})</span></p>
        </div>
        {!hasUsage && <p className="text-sm text-[var(--app-hint)]">{t('codexUsage.usageUnavailable')}</p>}
        <Rows values={[[t('codexUsage.includedUsage'), snapshot.ordinaryUsageAllowed === null ? null
            : snapshot.ordinaryUsageAllowed ? t('codexUsage.available') : t('codexUsage.unavailable')]]} />
        <div className="space-y-5">{snapshot.limits.map((value, index) => <Limit key={value.id ?? index} value={value} />)}</div>
        {snapshot.unavailable.rateLimits && <p className="whitespace-pre-wrap text-sm text-[var(--app-hint)]">{t('codexUsage.limitsUnavailable')} {snapshot.unavailable.rateLimits}</p>}
        {snapshot.resetCredits && <section className="space-y-2 pt-2">
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
        {thread && hasThread && <section className="space-y-2 pt-2">
            <h3 className="text-sm font-medium">{t('codexUsage.threadConsumption')}</h3>
            <Rows values={[
                [t('codexUsage.credits'), thread.creditsMicros === null ? null : decimal(codexMicroAmount(thread.creditsMicros))],
                [t('codexUsage.estimatedUsd'), thread.usdMicros === null ? null : commandNumber(codexMicroAmount(thread.usdMicros), { prefix: '$' })],
            ]} />
            {thread.groups.length > 0 && <details>
                <summary className="cursor-pointer text-sm">{t('codexUsage.modelBreakdown')}</summary>
                <div className="mt-3 space-y-4">{thread.groups.map((group, index) => <div key={index}>
                    <p className="mb-2 break-words text-sm font-medium">{[group.model, group.reasoning, group.speed].filter(Boolean).join(' · ') || t('codexUsage.modelUnknown')}</p>
                    <Rows values={[
                        [t('codexUsage.credits'), group.creditsMicros === null ? null : decimal(codexMicroAmount(group.creditsMicros))],
                        [t('codexUsage.inputTokens'), count(group.inputTokens)],
                        [t('codexUsage.newInputTokens'), count(group.newInputTokens)],
                        [t('codexUsage.cachedInputTokens'), count(group.cachedInputTokens)],
                        [t('codexUsage.outputTokens'), count(group.outputTokens)],
                        [t('codexUsage.totalTokens'), count(group.totalTokens)],
                    ]} />
                </div>)}</div>
            </details>}
        </section>}
        {summary && hasSummary && <details className="space-y-2 pt-2">
            <summary className="cursor-pointer text-sm font-medium">{t('codexUsage.accountActivity')}</summary>
            <Rows values={[
                [t('codexUsage.lifetimeTokens'), count(summary.lifetimeTokens)],
                [t('codexUsage.peakDailyTokens'), count(summary.peakDailyTokens)],
                [t('codexUsage.longestTurn'), summary.longestTurnSeconds === null ? null : t('codexUsage.seconds', { count: count(summary.longestTurnSeconds)! })],
                [t('codexUsage.currentStreak'), summary.currentStreakDays === null ? null : t('codexUsage.days', { count: count(summary.currentStreakDays)! })],
                [t('codexUsage.longestStreak'), summary.longestStreakDays === null ? null : t('codexUsage.days', { count: count(summary.longestStreakDays)! })],
            ]} />
        </details>}
        {snapshot.daily?.length ? <details className="pt-2 text-sm">
            <summary className="cursor-pointer">{t('codexUsage.dailyConsumption')}</summary>
            <div className="mt-2 max-h-64 overflow-y-auto"><Rows values={[...snapshot.daily].sort((a, b) => b.date.localeCompare(a.date)).map(day => [day.date, count(day.tokens)])} /></div>
        </details> : null}
        {snapshot.unavailable.usage && <p className="whitespace-pre-wrap text-sm text-[var(--app-hint)]">{t('codexUsage.usageUnavailable')} {snapshot.unavailable.usage}</p>}
    </div>
}
