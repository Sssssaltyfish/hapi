import type { ResponseAnnotation } from '@hapi/protocol'
export { appendBlockquote, appendResponseAnnotation, serializeResponseAnnotations, splitResponseAnnotations, type ResponseAnnotation, type ResponseAnnotationSource, type ResponseAnnotationTarget } from '@hapi/protocol'

/** Desktop jbs/Wbs count DOM Range UTF-16 text, relative to the text target. */
export function responseAnnotationFromRange(range: Range, text: string): ResponseAnnotation {
    const element = (node: Node) => node instanceof Element ? node : node.parentElement
    const target = element(range.startContainer)?.closest<HTMLElement>('[data-hapi-response-item-id]')
    const end = element(range.endContainer)?.closest('[data-hapi-response-item-id]')
    const messageId = target?.dataset.hapiResponseItemId
    if (!target || target !== end || !messageId) return { text }
    try {
        const before = range.cloneRange()
        before.selectNodeContents(target)
        before.setEnd(range.startContainer, range.startOffset)
        const raw = range.toString()
        const leading = raw.length - raw.trimStart().length
        const startOffset = before.toString().length + leading
        return { text, source: { messageId, startOffset, endOffset: startOffset + text.length,
            ...(target.dataset.hapiResponseTurnId ? { turnId: target.dataset.hapiResponseTurnId } : {}),
            ...(target.dataset.hapiResponsePartId ? { partId: target.dataset.hapiResponsePartId } : {}),
        } }
    } catch {
        return { text }
    }
}
