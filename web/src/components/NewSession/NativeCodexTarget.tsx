import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { nativeModelSummaries } from '@/codex-native/nativeModels'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'

export function useNativeCreationTarget(api: ApiClient, enabled: boolean) {
    const [endpointId, setEndpointId] = useState('')
    const endpoints = useQuery({ queryKey: ['codex-native', 'endpoints'], queryFn: () => api.getCodexNativeEndpoints(), enabled, staleTime: 30_000 })
    const configured = useMemo(() => endpoints.data?.endpoints ?? [], [endpoints.data])
    const selected = configured.find((endpoint) => endpoint.id === endpointId)
    useEffect(() => {
        if (!endpointId && configured.length === 1) setEndpointId(configured[0].id)
    }, [configured, endpointId])
    const models = useQuery({
        queryKey: ['codex-native', endpointId, 'models'],
        queryFn: () => api.withCodexNativeEndpoint(endpointId).getCodexNativeModels(),
        enabled: enabled && Boolean(selected), staleTime: 30_000,
    })
    const catalog = useMemo(() => nativeModelSummaries(models.data?.data ?? []), [models.data])
    return { endpointId, setEndpointId, configured, selected, endpoints, models,
        catalog: { models: catalog, isLoading: enabled && Boolean(selected) && models.isPending, error: models.error?.message ?? null } }
}

/** Only the execution target differs; all launch fields belong to NewSession. */
export function NativeCodexTarget(props: { target: ReturnType<typeof useNativeCreationTarget>; isDisabled: boolean }) {
    const { t } = useTranslation()
    const { target } = props
    return <div className="flex flex-col gap-1.5 px-3 py-3">
        <label className="text-xs font-medium text-[var(--app-hint)]" htmlFor="native-codex-host">{t('newSession.codexHost')}</label>
        <SelectControl id="native-codex-host" value={target.endpointId} disabled={props.isDisabled || target.endpoints.isPending} onChange={(event) => target.setEndpointId(event.target.value)} className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50">
            <option value="">{t('newSession.codexHost.select')}</option>
            {target.configured.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
        </SelectControl>
        {target.endpoints.isError ? <p role="alert" className="text-xs text-red-600">{target.endpoints.error.message}</p> : null}
        {!target.endpoints.isPending && !target.endpoints.isError && target.configured.length === 0 ? <p className="text-xs text-[var(--app-hint)]">{t('newSession.codexHost.none')}</p> : null}
    </div>
}
