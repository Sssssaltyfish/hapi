import { describe, expect, it } from 'vitest'
import { appendResponseAnnotation, responseAnnotationFromRange, serializeResponseAnnotations, splitResponseAnnotations } from './responseAnnotations'
import { projectNativeItems } from '@/codex-native/projectNativeItems'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { getResponseAnnotationTargets } from './assistant-runtime'
import type { NormalizedMessage } from '@/chat/types'

describe('Desktop response annotations', () => {
    it('carries the real source item through native projection, normalization and chat grouping', () => {
        const projected = projectNativeItems([
            { item: { id: 'actual-native-item-uuid', type: 'agentMessage', text: 'Native answer' } },
        ], [])
        const normalized = projected.messages.map(normalizeDecryptedMessage).filter((value): value is NormalizedMessage => value !== null)
        const { blocks } = reduceChatBlocks(normalized, { requests: {} })
        expect([...getResponseAnnotationTargets(blocks).values()]).toEqual([[{ messageId: 'actual-native-item-uuid', text: 'Native answer' }]])
    })
    it('round trips multiple selected texts, comments and opaque native IDs without changing the body', () => {
        const annotations = [
            { text: '中文 "quote"\nnext', source: { messageId: 'opaque/native:2', startOffset: 4, endOffset: 19 } },
            { text: 'second', annotation: 'Please explain this' },
        ]
        const body = 'Keep my draft\nwith whitespace  '
        const text = serializeResponseAnnotations(body, annotations)
        expect(text).toContain('\n# Response annotations:\n')
        expect(text).toContain('<response-annotations>\n[{')
        expect(splitResponseAnnotations(text)).toEqual({ body, annotations })
        expect(splitResponseAnnotations(appendResponseAnnotation(text, { text: 'third' })).annotations).toHaveLength(3)
        expect(splitResponseAnnotations(text.trim()).annotations).toEqual(annotations)
    })

    it('does not interpret examples or malformed envelopes as active draft annotations', () => {
        for (const text of [
            'Here is an example: ' + serializeResponseAnnotations('draft', [{ text: 'quote' }]),
            '# Response annotations:\n<response-annotations>\n[{"text":42}]\n</response-annotations>\nbody',
            '# Response annotations:\n<response-annotations>\ninvalid\n</response-annotations>\nbody',
        ]) expect(splitResponseAnnotations(text)).toEqual({ body: text, annotations: [] })
    })

    it('uses rendered UTF-16 offsets inside a verified native text target', () => {
        const target = document.createElement('div')
        target.dataset.hapiResponseItemId = 'actual-native-item'
        target.innerHTML = '<p>😀 Start <strong> selected中文 </strong>end</p>'
        const node = target.querySelector('strong')!.firstChild!
        const range = document.createRange()
        range.selectNodeContents(node)
        expect(responseAnnotationFromRange(range, range.toString().trim())).toEqual({
            text: 'selected中文',
            source: { messageId: 'actual-native-item', startOffset: 10, endOffset: 20 },
        })
    })

    it('omits source when selection spans native items', () => {
        const target = document.createElement('div')
        target.innerHTML = '<div data-hapi-response-item-id="one">First</div><div data-hapi-response-item-id="two">Second</div>'
        const range = document.createRange()
        range.setStart(target.firstChild!.firstChild!, 1)
        range.setEnd(target.lastChild!.firstChild!, 2)
        expect(responseAnnotationFromRange(range, range.toString())).toEqual({ text: 'irstSe' })
    })
})
