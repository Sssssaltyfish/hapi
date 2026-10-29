import { getFlavorLabel } from '@hapi/protocol'

export const CODEX_NATIVE_LABEL = 'Codex Native'
export type AgentIdentityMetadata = { flavor?: string | null; nativeCodex?: unknown }

/** UI identity only; native conversations retain the Codex wire protocol. */
export function getSessionAgentFlavor(metadata?: AgentIdentityMetadata | null): string | null {
    return metadata?.nativeCodex ? 'codex-native' : metadata?.flavor ?? null
}

export function getAgentIdentityLabel(flavor?: string | null): string {
    return flavor === 'codex-native' ? CODEX_NATIVE_LABEL : getFlavorLabel(flavor)
}
