export type NativeSessionIdentity = { endpointId: string; threadId: string }

export function parseCodexNativeSessionId(sessionId: string): NativeSessionIdentity | null {
    const match = /^codex-native:([^:]+):(.+)$/.exec(sessionId)
    return match ? { endpointId: match[1], threadId: match[2] } : null
}
