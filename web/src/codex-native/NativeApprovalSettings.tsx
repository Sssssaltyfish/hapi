import { useState } from 'react'
import { CODEX_APPROVAL_POLICIES, CODEX_APPROVALS_REVIEWERS } from '@hapi/protocol'
import type { NativeApprovalSettingsPatch } from './nativeSessionApiAdapter'
import { record } from './presentation'
import { useTranslation } from '@/lib/use-translation'

export function NativeApprovalSettings(props: {
    settings: Record<string, unknown>
    disabled: boolean
    onChange: (patch: NativeApprovalSettingsPatch) => Promise<void>
}) {
    const { t } = useTranslation()
    const [pending, setPending] = useState(false)
    const policy = props.settings.approvalPolicy
    const reviewer = props.settings.approvalsReviewer
    const policyKnown = typeof policy === 'string' && (CODEX_APPROVAL_POLICIES as readonly string[]).includes(policy)
    const reviewerKnown = typeof reviewer === 'string' && (CODEX_APPROVALS_REVIEWERS as readonly string[]).includes(reviewer)
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
                <select
                    aria-label={t('nativeApproval.reviewer')}
                    className="w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 disabled:opacity-50"
                    value={reviewerKnown && typeof reviewer === 'string' ? reviewer : ''}
                    disabled={props.disabled || pending || reviewer === undefined}
                    onChange={event => void change({ approvalsReviewer: event.target.value as 'user' | 'auto_review' })}
                >
                    {!reviewerKnown && <option value="" disabled>{t('nativeApproval.custom')}</option>}
                    {CODEX_APPROVALS_REVIEWERS.map(value => <option key={value} value={value}>{t(`nativeApproval.reviewer.${value}`)}</option>)}
                </select>
            </label>
            <label className="block space-y-1">
                <span className="text-xs text-[var(--app-hint)]">{t('nativeApproval.policy')}</span>
                <select
                    aria-label={t('nativeApproval.policy')}
                    className="w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 disabled:opacity-50"
                    value={policyKnown && typeof policy === 'string' ? policy : ''}
                    disabled={props.disabled || pending || policy === undefined}
                    onChange={event => void change({ approvalPolicy: event.target.value as 'on-request' | 'untrusted' | 'never' })}
                >
                    {!policyKnown && <option value="" disabled>{t('nativeApproval.custom')}</option>}
                    {CODEX_APPROVAL_POLICIES.map(value => <option key={value} value={value}>{t(`nativeApproval.policy.${value}`)}</option>)}
                </select>
            </label>
            <p className="text-xs text-[var(--app-hint)]">{t('nativeApproval.sandbox', { sandbox: sandboxLabel })}</p>
            <p className="text-xs text-[var(--app-hint)]">{t('nativeApproval.subsequentTurns')}</p>
        </div>
    )
}
