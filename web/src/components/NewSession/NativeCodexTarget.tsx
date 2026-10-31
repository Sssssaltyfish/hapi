import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { nativeModelSummaries } from '@/codex-native/nativeModels'
import { MachineSelectionField } from './MachineSelector'

export function useNativeCreationTarget(api: ApiClient, enabled: boolean, initialEndpointId?: string) {
    const [endpointId, setEndpointId] = useState(initialEndpointId ?? '')
    const endpoints = useQuery({
        queryKey: ['codex-native', 'endpoints'],
        queryFn: () => api.getCodexNativeEndpoints(),
        enabled,
        staleTime: 30_000,
    })
    const configured = useMemo(() => endpoints.data?.endpoints ?? [], [endpoints.data])
    const selected = configured.find((endpoint) => endpoint.id === endpointId)
    useEffect(() => {
        if (configured.length && !configured.some(endpoint => endpoint.id === endpointId)) setEndpointId(configured[0].id)
    }, [configured, endpointId])
    const models = useQuery({
        queryKey: ['codex-native', endpointId, 'models'],
        queryFn: () => api.withCodexNativeEndpoint(endpointId).getCodexNativeModels(),
        enabled: enabled && Boolean(selected),
        staleTime: 30_000,
    })
    const status = useQuery({
        queryKey: ['codex-native', endpointId, 'status'],
        queryFn: () => api.getCodexNativeEndpointStatus(endpointId),
        enabled: enabled && Boolean(selected),
        staleTime: 30_000,
        retry: false,
    })
    const catalog = useMemo(() => nativeModelSummaries(models.data?.data ?? []), [models.data])
    return {
        endpointId,
        setEndpointId,
        configured,
        selected,
        endpoints,
        models,
        status,
        catalog: {
            models: catalog,
            isLoading: enabled && (endpoints.isPending || (configured.length > 0 && (!selected || models.isPending))),
            error: endpoints.error?.message ?? models.error?.message ?? null,
        },
    }
}

/** Only the execution target differs; all launch fields belong to NewSession. */
export function NativeCodexTarget(props: {
    target: ReturnType<typeof useNativeCreationTarget>
    isDisabled: boolean
}) {
    const { target } = props
    return (
        <>
            <MachineSelectionField
                value={target.endpointId}
                options={target.configured.map((endpoint) => ({
                    kind: 'native',
                    id: endpoint.id,
                    label: endpoint.label,
                    ...(endpoint.id === target.endpointId && target.status.data?.platformOs
                        ? { platform: target.status.data.platformOs }
                        : {}),
                }))}
                isLoading={target.endpoints.isPending}
                isDisabled={props.isDisabled}
                onChange={target.setEndpointId}
            />
            {target.endpoints.isError ? (
                <p role="alert" className="px-3 py-2 text-xs text-red-600">
                    {target.endpoints.error.message}
                </p>
            ) : null}
        </>
    )
}
