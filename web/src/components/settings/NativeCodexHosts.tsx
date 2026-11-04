import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { NativeEndpoint } from '@/codex-native/types'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import { MACHINE_DISPLAY_NAME_MAX_LENGTH } from '@hapi/protocol'
import { MachineSettingsRow } from './MachineSettingsRow'

const endpointsKey = ['codex-native', 'endpoints'] as const

function NativeMachineRow(props: { api: ApiClient; endpoint: NativeEndpoint }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const status = useQuery({
        queryKey: ['codex-native', props.endpoint.id, 'status'],
        queryFn: () => props.api.getCodexNativeEndpointStatus(props.endpoint.id),
        staleTime: 30_000,
        retry: false,
    })
    const error = status.error?.message ?? status.data?.error
    const connection = t(status.isPending
        ? 'settings.native.checking'
        : status.data?.available
            ? 'settings.native.connected'
            : 'settings.native.disconnected')

    return (
        <MachineSettingsRow
            label={props.endpoint.label}
            displayName={props.endpoint.displayName}
            fallbackName={props.endpoint.baseLabel ?? props.endpoint.label}
            subtitle={[
                props.endpoint.address,
                status.data?.platformOs ?? status.data?.platformFamily,
                connection,
            ].filter(Boolean).join(' · ')}
            onRename={(displayName) => props.api.renameCodexNativeEndpoint(props.endpoint.id, displayName)}
            onRenamed={() => {
                void queryClient.invalidateQueries({ queryKey: endpointsKey })
                void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            }}
            trailing={
                <button
                    type="button"
                    disabled={status.isFetching}
                    onClick={() => void status.refetch()}
                    className="text-xs text-[var(--app-link)] disabled:opacity-50"
                >
                    {t('settings.native.refresh')}
                </button>
            }
        >
            {error ? (
                <div role="status" className="mt-1 break-words text-xs text-[var(--app-hint)]">
                    {error}
                </div>
            ) : null}
        </MachineSettingsRow>
    )
}

function AddNativeMachine({ api }: { api: ApiClient }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [open, setOpen] = useState(false)
    const [address, setAddress] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [token, setToken] = useState('')
    const submitting = useRef(false)
    const add = useMutation({
        mutationFn: () => api.createCodexNativeEndpoint({
            address: address.trim(),
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            ...(token ? { token } : {}),
        }),
        onSuccess: () => {
            setOpen(false)
            setAddress('')
            setDisplayName('')
            setToken('')
            void queryClient.invalidateQueries({ queryKey: endpointsKey })
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })
    const fieldClass = 'w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)] disabled:opacity-60'
    return (
        <div className="px-3 py-3">
            {!open ? (
                <button
                    type="button"
                    onClick={() => {
                        add.reset()
                        setOpen(true)
                    }}
                    className="text-sm text-[var(--app-link)]"
                >
                    {t('settings.native.addMachine')}
                </button>
            ) : (
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (!address.trim() || submitting.current) return
                        submitting.current = true
                        add.mutate(undefined, {
                            onSettled: () => {
                                submitting.current = false
                            },
                        })
                    }}
                >
                    <div className="text-sm font-medium">{t('settings.native.addMachine')}</div>
                    <label className="block space-y-1 text-xs text-[var(--app-hint)]">
                        <span>{t('settings.native.address')}</span>
                        <input
                            required
                            value={address}
                            disabled={add.isPending}
                            onChange={(event) => setAddress(event.target.value)}
                            placeholder="wss://host:port"
                            className={fieldClass}
                        />
                    </label>
                    <label className="block space-y-1 text-xs text-[var(--app-hint)]">
                        <span>{t('settings.native.displayName')}</span>
                        <input
                            value={displayName}
                            maxLength={MACHINE_DISPLAY_NAME_MAX_LENGTH}
                            disabled={add.isPending}
                            onChange={(event) => setDisplayName(event.target.value)}
                            className={fieldClass}
                        />
                    </label>
                    <label className="block space-y-1 text-xs text-[var(--app-hint)]">
                        <span>{t('settings.native.token')}</span>
                        <input
                            type="password"
                            autoComplete="new-password"
                            value={token}
                            disabled={add.isPending}
                            onChange={(event) => setToken(event.target.value)}
                            className={fieldClass}
                        />
                    </label>
                    {add.error ? (
                        <div role="alert" className="text-xs text-red-600">{add.error.message}</div>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            disabled={add.isPending}
                            onClick={() => {
                                setToken('')
                                setOpen(false)
                            }}
                        >
                            {t('button.cancel')}
                        </Button>
                        <Button type="submit" disabled={!address.trim() || add.isPending}>
                            {t(add.isPending ? 'settings.native.adding' : 'button.save')}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    )
}

/** Rows share the original Machines section; these are configured daemon targets. */
export function NativeCodexHosts({ api, hasRunnerMachines = false }: {
    api: ApiClient | null
    hasRunnerMachines?: boolean
}) {
    const { t } = useTranslation()
    const endpoints = useQuery({
        queryKey: endpointsKey,
        queryFn: () => api!.getCodexNativeEndpoints(),
        enabled: Boolean(api),
        staleTime: 30_000,
        retry: false,
    })

    return (
        <>
            {endpoints.isError ? (
                <div role="status" className="px-3 py-3 text-sm text-[var(--app-hint)]">
                    {t('settings.native.loadError')}
                </div>
            ) : null}
            {!hasRunnerMachines && !endpoints.data?.endpoints.length ? (
                <div className="px-3 py-3 text-sm text-[var(--app-hint)]">
                    {endpoints.isPending ? t('loading') : t('settings.machines.empty')}
                </div>
            ) : null}
            {endpoints.data?.endpoints.map((endpoint) => api ? (
                <NativeMachineRow key={endpoint.id} api={api} endpoint={endpoint} />
            ) : null)}
            {api ? <AddNativeMachine api={api} /> : null}
        </>
    )
}
