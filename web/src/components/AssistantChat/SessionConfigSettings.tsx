import { useState } from 'react'
import type { SessionConfigOption } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'

/** Labels and opaque values are owned by the running provider and its plugins. */
export function SessionConfigSettings(props: {
    api: ApiClient
    sessionId: string
    options: SessionConfigOption[]
    disabled: boolean
}) {
    const { t } = useTranslation()
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const select = async (id: string, value: string) => {
        if (pending || props.disabled) return
        setPending(true)
        setError(null)
        try {
            await props.api.setSessionConfigOption(props.sessionId, id, value)
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        } finally {
            setPending(false)
        }
    }
    return <div className="space-y-3 px-3 text-sm">
        {props.options.map(option => {
            const value = option.selectedValue ?? option.currentValue ?? ''
            const known = option.options.some(choice => choice.value === value)
            const description = option.options.find(choice => choice.value === value)?.description
            return <label key={option.id} className="block space-y-1">
                <span className="text-xs text-[var(--app-hint)]">{option.name ?? option.id}</span>
                <SelectControl aria-label={option.name ?? option.id} value={value}
                    disabled={props.disabled || pending || option.options.length === 0}
                    className="w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 disabled:opacity-50"
                    onChange={event => void select(option.id, event.target.value)}>
                    {!known && <option value={value} disabled>{value || t('sessionConfig.unavailable')}</option>}
                    {option.options.map(choice => <option key={choice.value} value={choice.value}>{choice.name ?? choice.value}</option>)}
                </SelectControl>
                {description && <span className="block text-xs text-[var(--app-hint)]">{description}</span>}
            </label>
        })}
        <p className="text-xs text-[var(--app-hint)]">{t('sessionConfig.nextMessages')}</p>
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    </div>
}
