import { appendBlockquote, appendResponseAnnotation, type ResponseAnnotation } from './responseAnnotations'

export type QuoteInputCapability = {
    format: 'codex-response-annotations' | 'plain-text'
    inputSurface: 'codex-desktop-text' | 'acp-prompt' | 'claude-sdk' | 'pi-rpc' | 'agy-print' | 'unverified'
}

/**
 * Describes the input HAPI can actually send, rather than every provider UI.
 * A plain-text fallback means no specific selection-reference primitive was
 * verified on that surface; it is not a claim that the provider lacks quoting.
 * Evidence and scope: docs/guide/response-quotes.md.
 */
export function resolveQuoteInputCapability(metadata?: { flavor?: string | null; nativeCodex?: unknown } | null): QuoteInputCapability {
    if (metadata?.nativeCodex || metadata?.flavor === 'codex')
        return { format: 'codex-response-annotations', inputSurface: 'codex-desktop-text' }
    switch (metadata?.flavor) {
        case 'cursor':
        case 'grok':
        case 'copilot':
        case 'kimi':
        case 'opencode':
        case 'dsh':
            return { format: 'plain-text', inputSurface: 'acp-prompt' }
        case 'claude':
            return { format: 'plain-text', inputSurface: 'claude-sdk' }
        case 'pi':
            return { format: 'plain-text', inputSurface: 'pi-rpc' }
        case 'agy':
            return { format: 'plain-text', inputSurface: 'agy-print' }
        default:
            return { format: 'plain-text', inputSurface: 'unverified' }
    }
}

export function appendSelectionQuote(draft: string, selection: ResponseAnnotation, capability: QuoteInputCapability): string {
    return capability.format === 'codex-response-annotations'
        ? appendResponseAnnotation(draft, selection)
        : appendBlockquote(draft, selection.text)
}
