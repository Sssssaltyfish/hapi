export type SessionCreationBrowseSearch = {
    directory?: string
    machineId?: string
    nativeEndpointId?: string
    shareTransferId?: string
    browseDraftId?: string
}

/** Both halves of the existing Browse round trip carry the same target and share. */
export function sessionCreationBrowseSearch(search: Record<string, unknown>): SessionCreationBrowseSearch {
    const result: SessionCreationBrowseSearch = {}
    for (const key of ['directory', 'machineId', 'nativeEndpointId', 'shareTransferId', 'browseDraftId'] as const) {
        if (typeof search[key] === 'string' && (key === 'directory' || search[key])) result[key] = search[key]
    }
    return result
}

export function selectedBrowserDirectorySearch(targetId: string, directory: string, context: SessionCreationBrowseSearch): SessionCreationBrowseSearch {
    return {
        directory,
        ...(context.nativeEndpointId ? { nativeEndpointId: targetId } : { machineId: targetId }),
        ...(context.shareTransferId ? { shareTransferId: context.shareTransferId } : {}),
        ...(context.browseDraftId ? { browseDraftId: context.browseDraftId } : {}),
    }
}
