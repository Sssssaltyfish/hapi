import type { AnnotationNavigationTarget } from './responseAnnotationResolver'

/** Resolve again after each commit: React may have replaced the text nodes. */
export function locateResponseAnnotation(viewport: HTMLElement, target: AnnotationNavigationTarget): { element: HTMLElement; range: Range } | null {
    const id = target.item.targetMessageId
    const element = [...viewport.querySelectorAll<HTMLElement>('[data-hapi-scroll-anchor], [data-hapi-scroll-anchors]')].find(element => {
        if (element.dataset.hapiScrollAnchor === id) return true
        try { return (JSON.parse(element.dataset.hapiScrollAnchors ?? '[]') as string[]).includes(id) } catch { return false }
    })
    if (!element) return null
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const text = nodes.map(node => node.data).join('')
    let start = target.source.startOffset
    let end = target.source.endOffset
    if (text.slice(start, end) !== target.text) {
        // Rendering can differ across client versions. A unique literal match is
        // safe; repeated text must never produce a guessed destination.
        start = text.indexOf(target.text)
        if (start < 0 || text.indexOf(target.text, start + 1) >= 0) return null
        end = start + target.text.length
    }
    const range = document.createRange()
    let offset = 0
    let started = false
    for (const node of nodes) {
        if (!started && start <= offset + node.length) { range.setStart(node, start - offset); started = true }
        if (started && end <= offset + node.length) { range.setEnd(node, end - offset); break }
        offset += node.length
    }
    return { element, range }
}

/** Pure navigation: safe to repeat while the virtual row is being measured. */
export function alignResponseAnnotation(viewport: HTMLElement, target: AnnotationNavigationTarget): boolean {
    const located = locateResponseAnnotation(viewport, target)
    if (!located) return false
    const rect = located.range.getClientRects()[0]
    if (!rect) return false
    const bounds = viewport.getBoundingClientRect()
    const delta = rect.top - bounds.top - 24
    if (Math.abs(delta) > 0.5) viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: 'instant' })
    const aligned = located.range.getClientRects()[0]
    return Boolean(aligned && bounds.height > 0 && aligned.height > 0 && aligned.bottom > bounds.top && aligned.top < bounds.bottom)
}

/** Highlight once after navigation completes, without changing its alignment. */
export function highlightResponseAnnotation(viewport: HTMLElement, target: AnnotationNavigationTarget): boolean {
    const located = locateResponseAnnotation(viewport, target)
    if (!located) return false
    const { element, range } = located
    // Custom Highlight does not replace the user's selection or alter React DOM.
    const highlights = (globalThis.CSS as typeof CSS & { highlights?: Map<string, unknown> } | undefined)?.highlights
    const HighlightClass = (globalThis as typeof globalThis & { Highlight?: new (range: Range) => unknown }).Highlight
    if (highlights && HighlightClass) {
        const highlight = new HighlightClass(range)
        highlights.set('hapi-quote-target', highlight)
        const style = document.createElement('style')
        style.textContent = '::highlight(hapi-quote-target) { background: #f6cf6480; color: inherit; }'
        document.head.append(style)
        setTimeout(() => { if (highlights.get('hapi-quote-target') === highlight) highlights.delete('hapi-quote-target'); style.remove() }, 3000)
    } else element.animate?.([{ backgroundColor: '#f6cf6440' }, { backgroundColor: 'transparent' }], { duration: 1800 })
    return true
}

/** Locate the real text part after the timeline has materialized its logical row. */
export function revealResponseAnnotation(viewport: HTMLElement, target: AnnotationNavigationTarget): boolean {
    return alignResponseAnnotation(viewport, target) && highlightResponseAnnotation(viewport, target)
}
