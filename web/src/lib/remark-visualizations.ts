import type { Processor } from 'unified'

const PREFIX = '\uE200visualize\uE202'
const END = 0xE201
const TOKEN = 'hapiVisualization'
const MAX_MARKER_LENGTH = 16 * 1024

export type VisualizationReference = { path: string; mode?: 'wide'; title?: string }

export function parseVisualizationReference(value: string): VisualizationReference | null {
    try {
        const payload = JSON.parse(value) as Partial<VisualizationReference> | null
        const path = payload?.path
        if (typeof path !== 'string' || !/\.html?$/i.test(path) || /[\x00-\x1f\x7f]/.test(path)) return null

        const windowsDrive = /^[a-z]:[\\/][^\\/]/i.test(path)
        const windowsShare = /^\\\\(?![?.][\\/])[^\\/]+[\\/][^\\/]+[\\/][^\\/]/.test(path)
        const posix = /^\/[^/]/.test(path)
        if (!windowsDrive && !windowsShare && !posix) return null

        const title = typeof payload?.title === 'string' ? payload.title.trim().slice(0, 250) : undefined
        return { path, mode: payload?.mode === 'wide' ? 'wide' : undefined, title: title || undefined }
    } catch {
        return null
    }
}

type Code = number | null
type State = (code: Code) => State | undefined
type Token = { type: string }
type Effects = { enter(type: string): void; consume(code: Code): void; exit(type: string): Token }
type MarkdownNode = {
    type: string
    value?: string
    children?: MarkdownNode[]
    data?: unknown
    position?: { start: { offset?: number }; end: { offset?: number } }
}
type CompileContext = {
    enter(node: MarkdownNode, token: Token): void
    exit(token: Token): void
    sliceSerialize(token: Token): string
}

function visualizationNode(value: string, reference: VisualizationReference): MarkdownNode {
    return {
        type: TOKEN,
        value,
        data: {
            hName: 'hapi-visualization',
            hProperties: { dataPath: reference.path, dataMode: reference.mode, title: reference.title },
            hChildren: [{ type: 'text', value }],
        },
    }
}

// Recognize the reference as Markdown text syntax so raw JSON escapes and
// punctuation never become emphasis, links, or separate text nodes.
function tokenize(this: { sliceSerialize(token: Token): string }, effects: Effects, ok: State, nok: State): State {
    const serialize = this.sliceSerialize.bind(this)
    let prefixIndex = 0
    let length = 0
    let quoted = false
    let escaped = false

    return start

    function start(code: Code) {
        effects.enter(TOKEN)
        return prefix(code)
    }

    function prefix(code: Code): State | undefined {
        if (code !== PREFIX.charCodeAt(prefixIndex)) return nok(code)
        effects.consume(code)
        prefixIndex++
        return prefixIndex === PREFIX.length ? body : prefix
    }

    function body(code: Code): State | undefined {
        // Micromark represents line endings as -5/-4/-3 and EOF as null.
        if (code === null || code < -2 || ++length > MAX_MARKER_LENGTH) return nok(code)
        if (code === END && !quoted) {
            effects.consume(code)
            const token = effects.exit(TOKEN)
            return parseVisualizationReference(serialize(token).slice(PREFIX.length, -1)) ? ok : nok
        }
        if (escaped) escaped = false
        else if (quoted && code === 92) escaped = true
        else if (code === 34) quoted = !quoted
        effects.consume(code)
        return body
    }
}

export function remarkVisualizations(this: Processor) {
    const data = this.data()
    const syntax = (data.micromarkExtensions ??= []) as unknown[]
    const compiler = (data.fromMarkdownExtensions ??= []) as unknown[]
    syntax.push({ text: { [PREFIX.charCodeAt(0)]: { tokenize } } })
    compiler.push({
        enter: {
            [TOKEN](this: CompileContext, token: Token) {
                const value = this.sliceSerialize(token)
                const reference = parseVisualizationReference(value.slice(PREFIX.length, -1))!
                this.enter(visualizationNode(value, reference), token)
            },
        },
        exit: { [TOKEN](this: CompileContext, token: Token) { this.exit(token) } },
    })

    return (tree: MarkdownNode, file: { toString(): string }) => {
        const source = file.toString()
        // Some providers omit Codex's private-use delimiters. Recover those
        // malformed references only as standalone top-level paragraphs.
        // Read its source span so Markdown never changes JSON escaping.
        for (const node of tree.children ?? []) {
            const start = node.position?.start.offset
            const end = node.position?.end.offset
            if (node.type !== 'paragraph' || start === undefined || end === undefined || end - start > MAX_MARKER_LENGTH) continue
            const value = source.slice(start, end)
            const payload = /^visualize(\{[^\r\n]*\})[ \t]*$/.exec(value)?.[1]
            const reference = payload ? parseVisualizationReference(payload) : null
            if (reference) node.children = [visualizationNode(value, reference)]
        }
        function visit(node: MarkdownNode, literal: boolean) {
            if (!node.children) return
            const childrenAreLiteral = literal || node.type === 'link' || node.type === 'linkReference'
            node.children = node.children.map(child => {
                if (childrenAreLiteral && child.type === TOKEN) return { type: 'text', value: child.value }
                visit(child, childrenAreLiteral)
                return child
            })
        }
        visit(tree, false)
    }
}
