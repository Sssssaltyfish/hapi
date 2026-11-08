import { matchesSearchQuery } from '@hapi/protocol'
import type { QueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Suggestion } from '@/hooks/useActiveSuggestions'

const LIMIT = 50

function workspaceSuggestion(flavor: string, path: string, label: string, description: string, group: 'files' | 'folders'): Suggestion {
    let text = JSON.stringify(path)
    if (flavor === 'codex') text = `@"${path.replace(/(["\\])/g, '\\$1')}"`
    if (flavor === 'copilot') text = `@${path}`
    return { key: `${group}:${path}`, text, label: `@${label}`, description, group }
}

export async function getRunnerWorkspaceSuggestions(
    api: ApiClient, queryClient: QueryClient, sessionId: string, workspace: string, flavor: string, query: string,
): Promise<Suggestion[]> {
    const windows = /^[A-Za-z]:[\\/]/.test(workspace) || workspace.startsWith('\\\\')
    const search = (windows ? query.replaceAll('\\', '/') : query).replace(/^(?:\.\/)+/, '')
    const slash = search.lastIndexOf('/')
    const directory = search.slice(0, slash + 1)
    const name = search.slice(slash + 1)
    const scope = api.getConversationCacheScope().key
    const [files, folders] = await Promise.allSettled([
        api.searchSessionFiles(sessionId, search, LIMIT),
        queryClient.fetchQuery({
            queryKey: ['runner-workspace-folders', scope, sessionId, directory],
            queryFn: async () => {
                const response = await api.listSessionDirectory(sessionId, directory)
                if (!response.success) throw new Error(response.error ?? 'Failed to list directory')
                return (response.entries ?? []).filter(entry => entry.type === 'directory')
            },
            retry: false,
            staleTime: 30_000,
        }),
    ])

    const suggestions = new Map<string, Suggestion>()
    if (files.status === 'fulfilled' && files.value.success) {
        for (const file of files.value.files ?? []) {
            const group = file.fileType === 'folder' ? 'folders' : 'files'
            const suggestion = workspaceSuggestion(flavor, file.fullPath, file.fileName, file.filePath || file.fullPath, group)
            suggestions.set(suggestion.key, suggestion)
        }
    }
    if (folders.status === 'fulfilled') {
        for (const folder of folders.value.filter(entry => matchesSearchQuery(entry.name, name)).slice(0, LIMIT)) {
            const path = `${directory}${folder.name}`
            const suggestion = workspaceSuggestion(flavor, path, folder.name, path, 'folders')
            suggestions.set(suggestion.key, suggestion)
        }
    }
    return [...suggestions.values()]
}
