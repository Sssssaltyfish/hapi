import type { ApiClient } from '@/api/client'
import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

export function nativeCatalogKey(api: ApiClient, endpointId: string, ...parts: string[]) {
    return ['codex-native-catalog', api.getConversationCacheScope?.().key ?? '', endpointId, ...parts] as const
}

export async function refreshNativeCatalog(client: QueryClient, api?: ApiClient, endpointIds?: readonly string[]) {
    await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.sessions }),
        ...(api && endpointIds ? endpointIds.map(id => client.invalidateQueries({ queryKey: nativeCatalogKey(api, id) })) : [client.invalidateQueries({ queryKey: ['codex-native-catalog'] })]),
    ])
}
