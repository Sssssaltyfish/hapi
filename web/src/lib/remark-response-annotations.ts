type MarkdownNode = {
    type?: string
    value?: string
    url?: string
    children?: MarkdownNode[]
}

export function responseAnnotationIndex(href: string | undefined): number | null {
    const match = /^hapi-annotation:([1-9]\d*)$/.exec(href ?? '')
    const index = match ? Number(match[1]) : NaN
    return Number.isSafeInteger(index) ? index : null
}

/** Interpret Codex's inline references only in prose, preserving code and links. */
export function remarkResponseAnnotations() {
    return (tree: MarkdownNode) => {
        const visit = (node: MarkdownNode) => {
            if (!node.children || ['code', 'inlineCode', 'link', 'linkReference'].includes(node.type ?? '')) return
            node.children = node.children.flatMap(child => {
                if (child.type !== 'text') { visit(child); return [child] }
                const value = child.value ?? ''
                const parts: MarkdownNode[] = []
                let offset = 0
                for (const match of value.matchAll(/:codex-annotation\{\s*index\s*=\s*(?:"([1-9]\d*)"|'([1-9]\d*)')\s*\}/g)) {
                    const start = match.index!
                    const index = Number(match[1] ?? match[2])
                    if (value[start - 1] === ':' || !Number.isSafeInteger(index)) continue
                    if (start > offset) parts.push({ type: 'text', value: value.slice(offset, start) })
                    parts.push({ type: 'link', url: `hapi-annotation:${index}`, children: [{ type: 'text', value: match[0] }] })
                    offset = start + match[0].length
                }
                if (!parts.length) return [child]
                if (offset < value.length) parts.push({ type: 'text', value: value.slice(offset) })
                return parts
            })
        }
        visit(tree)
    }
}
