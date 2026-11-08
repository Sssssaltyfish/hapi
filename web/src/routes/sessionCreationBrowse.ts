import { CREATABLE_AGENT_FLAVORS, type AgentFlavor } from '@hapi/protocol'

export type SessionCreationBrowseSearch = {
    directory?: string
    machineId?: string
    agent?: AgentFlavor
    nativeEndpointId?: string
    nativeProjectId?: string
    nativeProjectName?: string
    shareTransferId?: string
    browseDraftId?: string
}

/** Both halves of the existing Browse round trip carry the same target and share. */
export function sessionCreationBrowseSearch(search: Record<string, unknown>): SessionCreationBrowseSearch {
    const result: SessionCreationBrowseSearch = {}
    for (const key of ['directory', 'machineId', 'nativeEndpointId', 'nativeProjectId', 'nativeProjectName', 'shareTransferId', 'browseDraftId'] as const) {
        if (typeof search[key] === 'string' && (key === 'directory' || search[key])) result[key] = search[key]
    }
    const agent = CREATABLE_AGENT_FLAVORS.find(flavor => flavor === search.agent)
    if (agent) result.agent = agent
    return result
}

export function selectedBrowserDirectorySearch(targetId: string, directory: string, context: SessionCreationBrowseSearch): SessionCreationBrowseSearch {
    return {
        directory,
        ...(context.nativeEndpointId ? { nativeEndpointId: targetId } : { machineId: targetId }),
        ...(context.nativeEndpointId === targetId && context.nativeProjectId
            ? { nativeProjectId: context.nativeProjectId, nativeProjectName: context.nativeProjectName }
            : {}),
        ...(context.machineId === targetId && context.agent ? { agent: context.agent } : {}),
        ...(context.shareTransferId ? { shareTransferId: context.shareTransferId } : {}),
        ...(context.browseDraftId ? { browseDraftId: context.browseDraftId } : {}),
    }
}
