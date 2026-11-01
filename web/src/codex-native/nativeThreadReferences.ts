import type { ApiClient } from '@/api/client'
import {
    buildNativeThreadHref, extractSessionCitationIds, NATIVE_THREAD_REFERENCES_HEADER,
    NATIVE_THREAD_REFERENCES_INSTRUCTIONS, NATIVE_USER_REQUEST_HEADER, SESSION_REFERENCE_STEER_SUFFIX,
    type NativeThreadReference,
} from '@hapi/protocol/sessionCitation'
import { serializeResponseAnnotations } from '@/lib/responseAnnotations'
import { splitCodexInputContext } from '@hapi/protocol/codexInputContext'
import { parseCodexNativeSessionId } from './session-key'

/** Translate HAPI's existing composer chips to Desktop's verified host-scoped references. */
export async function nativeThreadReferenceMessage(
    api: ApiClient,
    current: { endpointId: string; threadId: string },
    message: string,
): Promise<string> {
    const parsed = splitCodexInputContext(message)
    const targets = extractSessionCitationIds(parsed.body).flatMap(sessionId => {
        const native = parseCodexNativeSessionId(sessionId)
        return native && !(native.endpointId === current.endpointId && native.threadId === current.threadId)
            ? [{ sessionId, ...native }] : []
    })
    if (!targets.length) return message
    if (targets.length > 32) throw new Error('Select at most 32 referenced Codex chats per message')
    const capabilities = await api.getCodexNativeReferenceCapabilities(current.threadId)
    if (!capabilities.readThread) throw new Error('This Codex chat cannot read referenced chats right now. Reconnect or remove the reference before sending.')
    const resolved = await Promise.all(targets.map(async target => {
        const reference = await api.resolveCodexNativeThreadReference({ threadId: target.threadId, targetEndpointId: target.endpointId })
        if (!reference.hostId) throw new Error('The selected Codex connection has no Desktop host mapping')
        return { sessionId: target.sessionId, reference: { hostId: reference.hostId, threadId: reference.threadId } }
    }))
    const references: NativeThreadReference[] = [...parsed.references]
    const hrefs = new Map<string, string>()
    const seen = new Set(parsed.references.map(reference => JSON.stringify([reference.hostId, reference.threadId])))
    for (const entry of resolved) {
        hrefs.set(entry.sessionId, buildNativeThreadHref(entry.reference.threadId, entry.reference.hostId))
        const key = JSON.stringify([entry.reference.hostId, entry.reference.threadId])
        if (!seen.has(key)) { seen.add(key); references.push(entry.reference) }
    }
    let body = parsed.body.replace(/(^|[\s("'=])((?:https?:\/\/[^/\s)\]"']+)?(?:\/[\w.-]+)*\/sessions\/([^/?#\s)\]"']+)(?:[?#][^\s)\]"']*)?)/g, (whole, prefix: string, _href: string, encoded: string) => {
        try {
            const href = hrefs.get(decodeURIComponent(encoded))
            return href ? prefix + href : whole
        } catch { return whole }
    })
    // Canonical plain-text copies carry the runner peer-tool instruction. Every
    // referenced target here is native, so its actual tool is read_thread.
    if (extractSessionCitationIds(parsed.body).every(id => hrefs.has(id))) body = body.split(SESSION_REFERENCE_STEER_SUFFIX).join('')
    const annotations = parsed.annotations.length ? serializeResponseAnnotations('', parsed.annotations).trim() : ''
    return [annotations, NATIVE_THREAD_REFERENCES_HEADER, NATIVE_THREAD_REFERENCES_INSTRUCTIONS,
        JSON.stringify(references), NATIVE_USER_REQUEST_HEADER, body].filter((value, index) => index !== 0 || value.length > 0).join('\n') + '\n'
}
