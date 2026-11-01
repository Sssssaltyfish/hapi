type AnchorPoint = {
    id: string
    topOffset: number
    kind?: 'content'
    textOffset?: number
    textContext?: string
    contextOffset?: number
}

export type ConversationScrollAnchor = AnchorPoint & {
    alternatives?: AnchorPoint[]
}

const CONTENT_SELECTOR = '[data-hapi-scroll-anchor], [data-hapi-scroll-anchors]'
const MESSAGE_SELECTOR = '.happy-thread-messages > [id]'

function keys(element: HTMLElement): string[] {
    const key = element.dataset.hapiScrollAnchor
    if (key) {
        return [key]
    }
    try {
        const aliases: unknown = JSON.parse(element.dataset.hapiScrollAnchors ?? '[]')
        return Array.isArray(aliases) ? aliases.filter((value): value is string => typeof value === 'string') : []
    } catch {
        return []
    }
}

function textRange(element: HTMLElement, offset: number): Range | null {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = offset
    while (walker.nextNode()) {
        const node = walker.currentNode
        const length = node.textContent?.length ?? 0
        if (remaining <= length && length > 0) {
            const range = element.ownerDocument.createRange()
            range.setStart(node, Math.min(remaining, length - 1))
            range.setEnd(node, Math.min(remaining + 1, length))
            return range
        }
        remaining -= length
    }
    return null
}

function capturePoint(element: HTMLElement, viewport: HTMLElement, id: string, content: boolean): AnchorPoint {
    const rect = element.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const point: AnchorPoint = { id, topOffset: rect.top - viewportRect.top, ...(content ? { kind: 'content' } : {}) }
    if (!content || rect.top >= viewportRect.top) {
        return point
    }
    const document = element.ownerDocument as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
        caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const x = Math.min(rect.right - 4, Math.max(rect.left + 16, viewportRect.left + 24))
    const y = Math.min(rect.bottom - 2, viewportRect.top + 24)
    const position = document.caretPositionFromPoint?.(x, y)
    const caret = position ? null : document.caretRangeFromPoint?.(x, y)
    const node = position?.offsetNode ?? caret?.startContainer
    const offset = position?.offset ?? caret?.startOffset
    if (!node || offset === undefined || !element.contains(node) || node.nodeType !== Node.TEXT_NODE
        || node.parentElement?.closest('[data-hapi-nested-scroll="true"]')) {
        return point
    }
    const prefix = document.createRange()
    prefix.selectNodeContents(element)
    prefix.setEnd(node, offset)
    const textOffset = prefix.toString().length
    const range = textRange(element, textOffset)
    const textRect = range?.getBoundingClientRect()
    if (textRect && textRect.height > 0) {
        point.textOffset = textOffset
        const text = element.textContent ?? ''
        const start = Math.max(0, textOffset - 24)
        point.textContext = text.slice(start, textOffset + 48)
        point.contextOffset = textOffset - start
        point.topOffset = textRect.top - viewportRect.top
    }
    return point
}

export function captureConversationScrollAnchor(viewport: HTMLElement): ConversationScrollAnchor | null {
    const rect = viewport.getBoundingClientRect()
    const visible = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect()
        return bounds.height > 0 && bounds.bottom > rect.top && bounds.top < rect.bottom
    }
    const content = Array.from(viewport.querySelectorAll<HTMLElement>(CONTENT_SELECTOR)).filter(visible)
    const points: AnchorPoint[] = []
    for (const element of content) {
        // Expanded tools have an actual row. A collapsed group's aliases are
        // useful only when no more precise visible child represents it.
        if (content.some(child => child !== element && element.contains(child))) {
            continue
        }
        const aliases = keys(element)
        const sampled = aliases.length <= 8 ? aliases : Array.from({ length: 8 }, (_, index) => aliases[Math.round(index * (aliases.length - 1) / 7)])
        if (sampled.length === 0) {
            continue
        }
        const point = capturePoint(element, viewport, sampled[0], true)
        for (const id of sampled) {
            points.push({ ...point, id })
        }
    }
    points.sort((a, b) => Math.abs(a.topOffset) - Math.abs(b.topOffset))
    for (const element of viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)) {
        if (visible(element)) {
            points.push(capturePoint(element, viewport, element.id, false))
        }
    }
    const [first, ...rest] = points.slice(0, 24)
    return first ? { ...first, ...(rest.length ? { alternatives: rest } : {}) } : null
}

export function restoreConversationScrollAnchor(viewport: HTMLElement, anchor: ConversationScrollAnchor): boolean {
    const content = Array.from(viewport.querySelectorAll<HTMLElement>(CONTENT_SELECTOR))
    for (const point of [anchor, ...(anchor.alternatives ?? [])]) {
        const target = point.kind === 'content'
            ? content.find(element => element.dataset.hapiScrollAnchor === point.id)
                ?? content.find(element => keys(element).includes(point.id))
            : viewport.ownerDocument.getElementById(point.id)
        if (!target || !viewport.contains(target)) {
            continue
        }
        let offset = point.textOffset
        if (point.textContext) {
            const text = target.textContent ?? ''
            const start = text.indexOf(point.textContext)
            if (start >= 0 && start === text.lastIndexOf(point.textContext)) {
                offset = start + (point.contextOffset ?? 0)
            }
        }
        const range = offset === undefined ? null : textRange(target, offset)
        const rect = range?.getBoundingClientRect() ?? target.getBoundingClientRect()
        viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top - point.topOffset
        return true
    }
    return false
}
