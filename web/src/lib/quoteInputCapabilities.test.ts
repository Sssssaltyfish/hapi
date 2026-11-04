import { expect, it } from 'vitest'
import { appendSelectionQuote, resolveQuoteInputCapability } from './quoteInputCapabilities'
import { splitResponseAnnotations } from './responseAnnotations'

it('keeps Desktop source and notes only on verified Codex annotation inputs', () => {
    const selection = { text: 'Selected', annotation: 'Explain this', source: { messageId: 'native-id', startOffset: 0, endOffset: 8 } }
    const codex = appendSelectionQuote('Draft', selection, resolveQuoteInputCapability({ nativeCodex: { threadId: 'thread' } }))
    expect(splitResponseAnnotations(codex)).toEqual({ body: 'Draft', annotations: [selection] })
    for (const flavor of ['claude', 'cursor', 'grok', 'copilot', 'kimi', 'opencode', 'dsh', 'pi', 'agy', 'future-agent']) {
        const text = appendSelectionQuote('Draft', selection, resolveQuoteInputCapability({ flavor }))
        expect(text).toBe('Draft\n\n> Selected\n\n')
        expect(text).not.toContain('response-annotations')
    }
})
