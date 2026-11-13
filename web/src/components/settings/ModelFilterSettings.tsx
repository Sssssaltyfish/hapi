import { useEffect, useState } from 'react'
import type { HubSettingsResponse, UpdateHubSettingsRequest } from '@hapi/protocol'
import { AGENT_FLAVORS } from '@hapi/protocol'
import { getAgentIdentityLabel } from '@/lib/agentIdentity'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'
import { SettingsSection } from './SettingsPrimitives'

export function ModelFilterSettings(props: {
    settings: HubSettingsResponse
    onSave: (patch: UpdateHubSettingsRequest) => void
    isSaving: boolean
    error: Error | null
}) {
    const { t } = useTranslation()
    const [provider, setProvider] = useState('agy')
    const saved = (props.settings.modelFilters?.[provider] ?? []).join(', ')
    const [draft, setDraft] = useState(saved)
    useEffect(() => setDraft(saved), [provider, saved])

    return (
        <SettingsSection title={t('settings.models.filters')}>
            <form className="space-y-3 px-3 py-3" onSubmit={event => {
                event.preventDefault()
                const patterns = draft.split(/[,，\n]/).map(value => value.trim()).filter(Boolean)
                props.onSave({ modelFilters: { [provider]: patterns } })
            }}>
                <SelectControl aria-label={t('newSession.agent')} value={provider} disabled={props.isSaving}
                    onChange={event => setProvider(event.target.value)} className="w-full rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 text-sm">
                    {[...AGENT_FLAVORS, 'codex-native'].map(flavor => <option key={flavor} value={flavor}>{getAgentIdentityLabel(flavor)}</option>)}
                </SelectControl>
                <div className="flex items-center gap-2">
                    <input aria-label={t('settings.models.filters')} value={draft} onChange={event => setDraft(event.target.value)}
                        placeholder="gemini-*" autoCapitalize="none" spellCheck={false}
                        className="min-w-0 flex-1 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 text-sm" />
                    <button type="submit" disabled={props.isSaving || draft === saved}
                        className="shrink-0 rounded-lg px-3 py-2 text-sm text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-40">
                        {t('button.save')}
                    </button>
                </div>
                <p className="text-xs text-[var(--app-hint)]">{t('settings.models.filters.hint')}</p>
                {props.error ? <p role="alert" className="text-xs text-red-600">{props.error.message}</p> : null}
            </form>
        </SettingsSection>
    )
}
