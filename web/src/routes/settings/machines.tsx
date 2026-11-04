import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { getMachineTitle } from '@/hooks/useMachineLabels'
import { queryKeys } from '@/lib/query-keys'
import { SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { NativeCodexHosts } from '@/components/settings/NativeCodexHosts'
import { MachineSettingsRow } from '@/components/settings/MachineSettingsRow'

function MachineRow(props: { api: ApiClient | null; machine: Machine }) {
    const queryClient = useQueryClient()
    const host = props.machine.metadata?.host
    return <MachineSettingsRow label={getMachineTitle(props.machine)} displayName={props.machine.metadata?.displayName}
        fallbackName={host} subtitle={[host, props.machine.metadata?.platform].filter(Boolean).join(' · ')}
        onRename={async displayName => {
            if (!props.api) throw new Error('API unavailable')
            await props.api.renameMachine(props.machine.id, displayName)
        }} onRenamed={() => { void queryClient.invalidateQueries({ queryKey: queryKeys.machines }) }} />
}

export default function SettingsMachinesPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { machines } = useMachines(api, true)
    return <SettingsPageContent description={t('settings.machines.description')}>
        <SettingsSection title={t('settings.machines.section')}>
            {machines.map(machine => <MachineRow key={machine.id} api={api} machine={machine} />)}
            <NativeCodexHosts api={api} hasRunnerMachines={machines.length > 0} />
        </SettingsSection>
    </SettingsPageContent>
}
