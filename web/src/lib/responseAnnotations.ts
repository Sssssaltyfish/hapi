export type ResponseAnnotationSource = {
    messageId: string
    startOffset: number
    endOffset: number
    /** Optional HAPI locator hints. Desktop accepts and strips unknown source keys. */
    turnId?: string
    partId?: string
}

export type ResponseAnnotation = {
    text: string
    annotation?: string
    source?: ResponseAnnotationSource
}

export type ResponseAnnotationTarget = { messageId: string; text: string }

const HEADER = '# Response annotations:'
const OPEN = '<response-annotations>'
const CLOSE = '</response-annotations>'
// Copied from the installed Desktop input builder (man/Kan), not inferred
// from app-server UserInput: these annotations travel inside ordinary text.
const INSTRUCTIONS = 'Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.'

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null
}

function parseAnnotation(value: unknown): ResponseAnnotation | null {
    const entry = record(value)
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return null
    if (entry.annotation !== undefined && typeof entry.annotation !== 'string') return null
    const rawSource = record(entry.source)
    const source = rawSource
        && typeof rawSource.messageId === 'string' && rawSource.messageId.length > 0
        && Number.isInteger(rawSource.startOffset) && Number.isInteger(rawSource.endOffset)
        && Number(rawSource.startOffset) >= 0 && Number(rawSource.endOffset) > Number(rawSource.startOffset)
        ? {
            messageId: rawSource.messageId,
            startOffset: Number(rawSource.startOffset),
            endOffset: Number(rawSource.endOffset),
            ...(typeof rawSource.turnId === 'string' && rawSource.turnId ? { turnId: rawSource.turnId } : {}),
            ...(typeof rawSource.partId === 'string' && rawSource.partId ? { partId: rawSource.partId } : {}),
        } satisfies ResponseAnnotationSource : undefined
    return {
        text: entry.text,
        ...(typeof entry.annotation === 'string' && entry.annotation ? { annotation: entry.annotation } : {}),
        ...(source ? { source } : {}),
    }
}

/** A strict prefix parser. Quoted examples and malformed protocols remain text. */
export function splitResponseAnnotations(text: string): { body: string; annotations: ResponseAnnotation[] } {
    const plain = { body: text, annotations: [] as ResponseAnnotation[] }
    const start = text.trimStart()
    if (!start.startsWith(`${HEADER}\n`)) return plain
    const open = start.indexOf(`\n${OPEN}\n`, HEADER.length)
    if (open < 0) return plain
    const jsonStart = open + OPEN.length + 2
    const close = start.indexOf(`\n${CLOSE}\n`, jsonStart)
    // A final closing tag is valid even when a transport trims the last newline.
    const end = close < 0 && start.endsWith(`\n${CLOSE}`) ? start.length - CLOSE.length - 1 : close
    if (end < 0) return plain
    try {
        const parsed: unknown = JSON.parse(start.slice(jsonStart, end))
        if (!Array.isArray(parsed) || parsed.length === 0) return plain
        const annotations = parsed.map(parseAnnotation)
        if (annotations.some(entry => entry === null)) return plain
        return {
            body: start.slice(end + CLOSE.length + 1).replace(/^\n/, ''),
            annotations: annotations as ResponseAnnotation[],
        }
    } catch {
        return plain
    }
}

export function serializeResponseAnnotations(body: string, annotations: readonly ResponseAnnotation[]): string {
    if (annotations.length === 0) return body
    return `\n${HEADER}\n${INSTRUCTIONS}\n${OPEN}\n${JSON.stringify(annotations)}\n${CLOSE}\n${body}`
}

export function appendResponseAnnotation(draft: string, annotation: ResponseAnnotation): string {
    const existing = splitResponseAnnotations(draft)
    return serializeResponseAnnotations(existing.body, [...existing.annotations, annotation])
}

export function appendBlockquote(draft: string, selection: string): string {
    const quote = selection.trim().split(/\r?\n/).map(line => `> ${line}`).join('\n')
    return `${draft.trimEnd()}${draft.trim() ? '\n\n' : ''}${quote}\n\n`
}

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
