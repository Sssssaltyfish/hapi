import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { SettingsSection } from './SettingsPrimitives'
import { CODEX_NATIVE_LABEL } from '@/lib/agentIdentity'
import { useTranslation } from '@/lib/use-translation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'

function NativeHost(props: { api: ApiClient; endpoint: { id: string; label: string; defaultCwd?: string } }) {
    const { t } = useTranslation()
    const status = useQuery({
        queryKey: ['codex-native', props.endpoint.id, 'status'],
        queryFn: () => props.api.withCodexNativeEndpoint(props.endpoint.id).getCodexNativeStatus(),
        staleTime: 30_000,
        retry: false,
    })
    const available = status.data?.available === true
    const error = status.error instanceof Error ? status.error.message : status.data?.error
    return (
        <div className="px-3 py-3">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium"><AgentFlavorIcon flavor="codex-native" className="h-[18px] w-[18px]" />{props.endpoint.label}</div>
                    <div className="text-xs text-[var(--app-hint)]">{CODEX_NATIVE_LABEL} · {t(status.isPending ? 'settings.native.checking' : available ? 'settings.native.connected' : 'settings.native.disconnected')}</div>
                </div>
                <button type="button" disabled={status.isFetching} onClick={() => void status.refetch()} className="text-xs text-[var(--app-link)] disabled:opacity-50">{t('settings.native.refresh')}</button>
            </div>
            {props.endpoint.defaultCwd ? <div className="mt-1 break-all text-xs text-[var(--app-hint)]">{t('settings.native.directory')} {props.endpoint.defaultCwd}</div> : null}
            {error ? <div role="status" className="mt-1 break-words text-xs text-[var(--app-hint)]">{error}</div> : null}
        </div>
    )
}

export function NativeCodexHosts({ api }: { api: ApiClient | null }) {
    const { t } = useTranslation()
    const endpoints = useQuery({
        queryKey: ['codex-native', 'endpoints'],
        queryFn: () => api!.getCodexNativeEndpoints(),
        enabled: Boolean(api),
        staleTime: 30_000,
        retry: false,
    })
    return (
        <SettingsSection title={CODEX_NATIVE_LABEL}>
            {endpoints.isPending ? <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('loading')}</div> : endpoints.isError ? <div role="status" className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.native.loadError')}</div> : endpoints.data?.endpoints.length ? endpoints.data.endpoints.map(endpoint => api ? <NativeHost key={endpoint.id} api={api} endpoint={endpoint} /> : null) : <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.native.empty')}</div>}
            <details className="px-3 py-2 text-xs text-[var(--app-hint)]">
                <summary className="cursor-pointer">{t('settings.native.configuration')}</summary>
                <p className="mt-2">{t('settings.native.help')}</p>
                <p className="mt-1 break-words">HAPI_CODEX_NATIVE_ENDPOINTS · HAPI_CODEX_NATIVE_SOCKET · HAPI_CODEX_NATIVE_NAMESPACE</p>
            </details>
        </SettingsSection>
    )
}
