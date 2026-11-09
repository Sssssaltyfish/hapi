import { useState } from 'react'
import { CODEX_APPROVAL_POLICIES, CODEX_APPROVALS_REVIEWERS } from '@hapi/protocol'
import type { NativeApprovalSettingsPatch } from './nativeSessionApiAdapter'
import { record } from './presentation'
import { useTranslation, type I18nContextValue } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'

function getNativeApprovalOptions(settings: Record<string, unknown>) {
    return {
        policy: CODEX_APPROVAL_POLICIES.find(value => value === settings.approvalPolicy),
        reviewer: CODEX_APPROVALS_REVIEWERS.find(value => value === settings.approvalsReviewer),
    }
}

export function getNativeApprovalStatusLabel(settings: Record<string, unknown>, t: I18nContextValue['t']): string | null {
    const { policy, reviewer } = getNativeApprovalOptions(settings)
    if (policy === 'never') return t('nativeApproval.status.noPrompts')
    if (reviewer === 'user') return t('nativeApproval.status.manualReview')
    if (reviewer) return t(`nativeApproval.reviewer.${reviewer}`)
    if (policy) return t(`nativeApproval.policy.${policy}`)
    if (Object.hasOwn(record(settings.approvalPolicy), 'granular')) return t('nativeApproval.status.granular')
    return null
}

export function NativeApprovalSettings(props: {
    settings: Record<string, unknown>
    disabled: boolean
    onChange: (patch: NativeApprovalSettingsPatch) => Promise<void>
}) {
    const { t } = useTranslation()
    const [pending, setPending] = useState(false)
    const { policy, reviewer } = getNativeApprovalOptions(props.settings)
    const sandbox = record(props.settings.sandboxPolicy).type
    const sandboxLabel = sandbox === 'readOnly' ? t('nativeApproval.sandbox.readOnly')
        : sandbox === 'workspaceWrite' ? t('nativeApproval.sandbox.workspaceWrite')
            : sandbox === 'dangerFullAccess' ? t('nativeApproval.sandbox.fullAccess')
                : t('nativeApproval.custom')
    const change = async (patch: NativeApprovalSettingsPatch) => {
        if (pending || props.disabled) return
        setPending(true)
        try {
            await props.onChange(patch)
        } catch {
            // The adapter surfaces the daemon's error in the conversation warning.
        } finally {
            setPending(false)
        }
    }
    return (
        <div className="space-y-3 px-3 text-sm">
            <label className="block space-y-1">
                <span className="text-xs text-[var(--app-hint)]">{t('nativeApproval.reviewer')}</span>
                <SelectControl
                    aria-label={t('nativeApproval.reviewer')}
                    className="w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 disabled:opacity-50"
                    value={reviewer ?? ''}
                    disabled={props.disabled || pending || props.settings.approvalsReviewer === undefined}
                    onChange={event => void change({ approvalsReviewer: event.target.value as 'user' | 'auto_review' })}
                >
                    {reviewer === undefined && <option value="" disabled>{t('nativeApproval.custom')}</option>}
                    {CODEX_APPROVALS_REVIEWERS.map(value => <option key={value} value={value}>{t(`nativeApproval.reviewer.${value}`)}</option>)}
                </SelectControl>
            </label>
            <label className="block space-y-1">
                <span className="text-xs text-[var(--app-hint)]">{t('nativeApproval.policy')}</span>
                <SelectControl
                    aria-label={t('nativeApproval.policy')}
                    className="w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 disabled:opacity-50"
                    value={policy ?? ''}
                    disabled={props.disabled || pending || props.settings.approvalPolicy === undefined}
                    onChange={event => void change({ approvalPolicy: event.target.value as 'on-request' | 'untrusted' | 'never' })}
                >
                    {policy === undefined && <option value="" disabled>{t('nativeApproval.custom')}</option>}
                    {CODEX_APPROVAL_POLICIES.map(value => <option key={value} value={value}>{t(`nativeApproval.policy.${value}`)}</option>)}
                </SelectControl>
            </label>
            <p className="text-xs text-[var(--app-hint)]">{t('nativeApproval.sandbox', { sandbox: sandboxLabel })}</p>
            <p className="text-xs text-[var(--app-hint)]">{t('nativeApproval.subsequentTurns')}</p>
        </div>
    )
}
