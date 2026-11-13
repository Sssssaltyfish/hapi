import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

const EMPTY_FILTERS: Record<string, string[]> = {}

export function useModelFilters(api: ApiClient) {
    const query = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: () => api.getHubSettings(),
        staleTime: 30_000,
        retry: false,
    })
    return query.data?.modelFilters ?? EMPTY_FILTERS
}
