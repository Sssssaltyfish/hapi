import type { Machine } from '@/types/api'
import { isMachineCapabilitySkewed } from '@hapi/protocol/runnerCapabilities'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'
import { formatMachinePlatform } from '@/lib/machineHealth'

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

function getMachineOptionLabel(machine: Machine, t: (key: string) => string): string {
    const title = getMachineTitle(machine)
    const os = formatMachinePlatform(machine.metadata?.platform, t)
    const platform = os ? ` (${os})` : ''
    const version = machine.metadata?.happyCliVersion
        ? ` · CLI ${machine.metadata.happyCliVersion}`
        : ''
    const skew = machine.active && isMachineCapabilitySkewed(machine.metadata?.capabilities)
        ? ` · ${t('runner.skew.updateRequired')}`
        : ''
    return `${title}${platform}${version}${skew}`
}

export function MachineSelector(props: {
    machines: Machine[]
    machineId: string | null
    isLoading?: boolean
    isDisabled: boolean
    onChange: (machineId: string) => void
}) {
    const { t } = useTranslation()

    return (
        <MachineSelectionField
            options={props.machines.map((machine) => ({
                kind: 'runner',
                id: machine.id,
                label: getMachineOptionLabel(machine, t),
            }))}
            value={props.machineId}
            isLoading={props.isLoading}
            isDisabled={props.isDisabled}
            onChange={props.onChange}
        />
    )
}

export type MachineSelectionOption = {
    kind: 'runner' | 'native'
    id: string
    label: string
    platform?: string
}

/** Shared target selector presentation; native endpoints do not become runner Machines. */
export function MachineSelectionField(props: {
    options: readonly MachineSelectionOption[]
    value: string | null
    isLoading?: boolean
    isDisabled: boolean
    placeholder?: string
    onChange: (id: string) => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.machine')}
            </label>
            <SelectControl
                aria-label={t('newSession.machine')}
                value={props.value ?? ''}
                onChange={(e) => props.onChange(e.target.value)}
                disabled={props.isDisabled}
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {props.isLoading && (
                    <option value="">{t('loading.machines')}</option>
                )}
                {!props.isLoading && props.options.length === 0 && (
                    <option value="">{t('misc.noMachines')}</option>
                )}
                {!props.isLoading && props.options.length > 0 && props.placeholder ? (
                    <option value="">{props.placeholder}</option>
                ) : null}
                {!props.isLoading && props.value && !props.options.some(option => option.id === props.value) ? (
                    <option value={props.value} disabled>{props.value}</option>
                ) : null}
                {props.options.map((option) => {
                    const platform = formatMachinePlatform(option.platform, t)
                    return <option key={`${option.kind}:${option.id}`} value={option.id}>
                        {option.label}{platform ? ` (${platform})` : ''}
                    </option>
                })}
            </SelectControl>
        </div>
    )
}
