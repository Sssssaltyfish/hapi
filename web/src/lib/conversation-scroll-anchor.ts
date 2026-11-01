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
const MESSAGE_SELECTOR = '.happy-thread-messages > [id], .happy-thread-messages [data-hapi-message-role][id]'

function verticalClip(element: HTMLElement, viewport: HTMLElement): { top: number; bottom: number } {
    const bounds = viewport.getBoundingClientRect()
    let top = bounds.top
    let bottom = bounds.bottom
    for (let parent: HTMLElement | null = element; parent && parent !== viewport; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowY
        if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden' || overflow === 'clip') {
            const rect = parent.getBoundingClientRect()
            top = Math.max(top, rect.top)
            bottom = Math.min(bottom, rect.bottom)
        }
    }
    return { top, bottom }
}

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

function capturePoint(element: HTMLElement, viewport: HTMLElement, id: string, content: boolean, clip = verticalClip(element, viewport)): AnchorPoint {
    const rect = element.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const point: AnchorPoint = { id, topOffset: rect.top - viewportRect.top, ...(content ? { kind: 'content' } : {}) }
    if (!content || rect.top >= clip.top) {
        return point
    }
    const document = element.ownerDocument as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
        caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const x = Math.min(rect.right - 4, Math.max(rect.left + 16, viewportRect.left + 24))
    const y = Math.min(rect.bottom - 2, clip.bottom - 2, clip.top + 24)
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
    // A caret API may return the nearest text above a clipped card. Such a
    // character is not the reader's visible position, even if the card's
    // border still intersects the viewport.
    if (textRect && textRect.height > 0 && textRect.top >= clip.top && textRect.top + textRect.height <= clip.bottom) {
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
        if (bounds.height <= 0 || bounds.bottom <= rect.top || bounds.top >= rect.bottom) {
            return false
        }
        const clip = verticalClip(element, viewport)
        return bounds.bottom > clip.top && bounds.top < clip.bottom && clip.top < clip.bottom
    }
    const content = Array.from(viewport.querySelectorAll<HTMLElement>(CONTENT_SELECTOR)).filter(visible)
    const points: { point: AnchorPoint; visible: boolean }[] = []
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
        const clip = verticalClip(element, viewport)
        const point = capturePoint(element, viewport, sampled[0], true, clip)
        const top = element.getBoundingClientRect().top
        const visiblePoint = point.textOffset !== undefined || (top >= clip.top && top < clip.bottom)
        for (const id of sampled) {
            points.push({ point: { ...point, id }, visible: visiblePoint })
        }
    }
    points.sort((a, b) => Number(b.visible) - Number(a.visible) || Math.abs(a.point.topOffset) - Math.abs(b.point.topOffset))
    const candidates = points.map(value => value.point)
    for (const element of viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)) {
        if (visible(element)) {
            candidates.push(capturePoint(element, viewport, element.id, false))
        }
    }
    const [first, ...rest] = candidates.slice(0, 24)
    return first ? { ...first, ...(rest.length ? { alternatives: rest } : {}) } : null
}

export function getConversationScrollAnchorPosition(viewport: HTMLElement, anchor: ConversationScrollAnchor): {
    currentOffset: number
    targetOffset: number
} | null {
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
        return { currentOffset: rect.top - viewport.getBoundingClientRect().top, targetOffset: point.topOffset }
    }
    return null
}

export function restoreConversationScrollAnchor(viewport: HTMLElement, anchor: ConversationScrollAnchor): boolean {
    const position = getConversationScrollAnchorPosition(viewport, anchor)
    if (!position) return false
    viewport.scrollTop += position.currentOffset - position.targetOffset
    return true
}
