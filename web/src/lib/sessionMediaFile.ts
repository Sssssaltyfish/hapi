import type { ApiClient } from '@/api/client'
import { parseCodexNativeSessionId, type NativeSessionIdentity } from '@/codex-native/session-key'
import { base64FileBlob } from '@/lib/file-download'

export function getMediaNativeIdentity(sessionId: string, metadataIdentity?: NativeSessionIdentity | null) {
    return parseCodexNativeSessionId(sessionId) ?? metadataIdentity ?? null
}

export async function readSessionMediaBlob(
    api: ApiClient,
    sessionId: string,
    endpointId: string | undefined,
    threadId: string | undefined,
    path: string,
    mimeType: string | null,
    signal: AbortSignal,
): Promise<Blob> {
    const file = endpointId && threadId
        ? await api.readCodexNativeFile(endpointId, threadId, path, signal)
        : await api.readSessionFile(sessionId, path, signal)
    signal.throwIfAborted()
    if (!file.success || typeof file.content !== 'string') throw new Error(file.error ?? 'Failed to read file')
    return base64FileBlob(file.content, mimeType)
}
