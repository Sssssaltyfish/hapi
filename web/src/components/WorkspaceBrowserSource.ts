import type { ApiClient } from '@/api/client'
import type { NativeEndpoint } from '@/codex-native/types'
import type { Machine, MachineDirectoryEntry } from '@/types/api'

export type WorkspaceBrowserMachine = { id: string; label: string; roots?: readonly string[] }
export type WorkspaceBrowserSource = {
    key: string
    machines: readonly WorkspaceBrowserMachine[]
    isLoading: boolean
    rootConfigurationHelp?: boolean
    loadRoots?: (machineId: string) => Promise<{ roots: string[]; initialPath?: string }>
    listDirectory: (machineId: string, path: string, includeHidden: boolean) => Promise<{ success: boolean; entries?: MachineDirectoryEntry[]; error?: string; truncated?: boolean }>
    onDirectoryError?: () => void
}

export function runnerWorkspaceBrowserSource(api: ApiClient, machines: Machine[], isLoading: boolean, onDirectoryError?: () => void): WorkspaceBrowserSource {
    return {
        key: 'runner',
        machines: machines.map(machine => ({ id: machine.id, label: machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8), roots: machine.metadata?.workspaceRoots ?? [] })),
        isLoading,
        rootConfigurationHelp: true,
        listDirectory: (machineId, path, includeHidden) => api.listMachineDirectory(machineId, path, { includeHidden }),
        onDirectoryError,
    }
}

export function filesystemRoot(path: string): string {
    const drive = /^([A-Za-z]:)[\\/]/.exec(path)
    if (drive) return `${drive[1]}${path.includes('\\') ? '\\' : '/'}`
    const share = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)/.exec(path)
    if (share) return path.startsWith('\\') ? `\\\\${share[1]}\\${share[2]}\\` : `//${share[1]}/${share[2]}/`
    return '/'
}

export function nativeWorkspaceBrowserSource(api: ApiClient, endpoints: readonly NativeEndpoint[], isLoading: boolean, initialEndpointId: string, initialDirectory?: string): WorkspaceBrowserSource {
    return {
        key: 'codex-native',
        machines: endpoints.map(endpoint => ({ id: endpoint.id, label: endpoint.label })),
        isLoading,
        loadRoots: async endpointId => {
            const requested = endpointId === initialEndpointId ? initialDirectory?.trim() : undefined
            const absolute = requested && (requested.startsWith('/') || requested.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(requested))
            const path = absolute ? requested : (await api.listCodexNativeDirectory(endpointId, '')).path
            return { roots: [filesystemRoot(path)], initialPath: path }
        },
        listDirectory: async (endpointId, path, includeHidden) => {
            const directory = await api.listCodexNativeDirectory(endpointId, path, includeHidden)
            return { success: true, entries: directory.entries.map(entry => ({ name: entry.fileName, type: 'directory' as const })), truncated: directory.truncated }
        },
    }
}
