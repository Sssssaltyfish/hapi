import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { nativeQuestionReplyDisplayText } from '@hapi/protocol'
import type { DecryptedMessage } from '@hapi/protocol/types'
import type { MessagesResponse } from '@hapi/protocol/apiTypes'
import { record, type NativeRecord } from '../codexNative/transport'

export type OutlineLocator =
    | {
        kind: 'native'
        cursor: string | null
    }
    | {
        kind: 'runner'
        beforeAt: number | null
        beforeSeq: number | null
        epoch: number | null
    }
export type OutlineItem = {
    id: string
    targetMessageId: string
    kind: 'user'
    label: string
    createdAt: number
    historyPage: OutlineLocator
}
export type OutlinePage = {
    items: OutlineItem[]
    next: OutlineLocator | null
    scanned: number
    epoch: number | null
    reachedHead: boolean
    overlapId?: string
}
const MAX_PAGES = 4
const MAX_SCAN_BYTES = 2 * 1024 * 1024
const MAX_SCAN_MS = 1500
// A native page is atomic; byte/time budgets prevent fetching another page.

function preview(value: string): string {
    const text = nativeQuestionReplyDisplayText(value).replace(/\s+/g, ' ').trim()
    return text.length > 96 ? `${text.slice(0, 93).trimEnd()}...` : text || 'Empty message'
}
function outlineItem(id: string, text: string, at: number, locator: OutlineLocator): OutlineItem {
    return {
        id: `outline:user-text:${id}`,
        targetMessageId: `user-text:${id}`,
        kind: 'user',
        label: preview(text),
        createdAt: at,
        historyPage: locator
    }
}
function userText(message: DecryptedMessage): string | null {
    const envelope = unwrapRoleWrappedRecordEnvelope(message.content)
    if (envelope?.role !== 'user' || message.invokedAt === null) return null
    const content = envelope.content
    return typeof content === 'string' ? content : typeof record(content).text === 'string' ? record(content).text as string : null
}

/** Full native items are authoritative: turn summaries omit accepted steering input. */
export async function nativeOutlinePage(
    read: (params: NativeRecord) => Promise<unknown>,
    cursor: string | null,
    stopIds: string[] = [],
): Promise<OutlinePage> {
    const scanUntil = Date.now() + MAX_SCAN_MS
    const items: OutlineItem[] = []
    let next: OutlineLocator | null = { kind: 'native', cursor }
    let scanned = 0
    let bytes = 0
    let reachedHead = false
    let overlapId: string | undefined
    do {
        const locator: OutlineLocator = { kind: 'native', cursor }
        // A started page retains the normal RPC timeout. The scan budget only
        // decides whether to request another page after this one completes.
        const page = record(await read({ cursor: cursor ?? undefined, limit: 50, sortDirection: 'desc' }))
        bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
        scanned++
        for (const raw of Array.isArray(page.data) ? page.data : []) {
            const entry = record(raw)
            const item = record(entry.item)
            if (item.type !== 'userMessage' && !(item.type === 'steeringUserMessage' && item.status === 'accepted')) continue
            const id = `native:${String(item.id)}`
            const content = item.content ?? item.input
            const text = Array.isArray(content) ? content.map(value => {
                const part = record(value)
                if (typeof part.text === 'string') return part.text
                if (part.type === 'mention') return ''
                return part.type === 'image' ? '[Image]' : part.type ? `[${String(part.type)}: ${String(part.path ?? part.name ?? '')}]` : ''
            }).filter(Boolean).join('\n') : typeof content === 'string' ? content : ''
            if (text) items.push(outlineItem(id, text, Number(entry.startedAtMs ?? entry.completedAtMs ?? entry.observedAtMs ?? 0), locator))
            // Include the boundary so an accepted/edited user item can refresh its preview.
            if (stopIds.includes(`user-text:${id}`)) {
                reachedHead = true; overlapId = `user-text:${id}`; break
            }
        }
        const after = typeof page.nextCursor === 'string' ? page.nextCursor : null
        if (after && after === cursor) throw new Error('Outline history cursor did not advance')
        cursor = after
        next = !reachedHead && after ? { kind: 'native', cursor: after } : null
    } while (next && scanned < MAX_PAGES && bytes < MAX_SCAN_BYTES && Date.now() < scanUntil)
    return {
        items,
        next,
        scanned,
        epoch: null,
        reachedHead,
        ...(overlapId ? { overlapId } : {})
    }
}

export function runnerOutlinePage(
    read: (locator: Extract<OutlineLocator, {
        kind: 'runner'
    }>) => MessagesResponse,
    locator: Extract<OutlineLocator, {
        kind: 'runner'
    }>,
    stopIds: string[] = [],
): OutlinePage {
    const started = Date.now()
    const items: OutlineItem[] = []
    let next: OutlineLocator | null = locator
    let scanned = 0
    let bytes = 0
    let epoch = locator.epoch
    let reachedHead = false
    let overlapId: string | undefined
    do {
        const current = next as Extract<OutlineLocator, {
            kind: 'runner'
        }>
        const page = read(current)
        epoch = page.page.epoch
        if (current.epoch !== null && current.epoch !== epoch) return {
            items: [],
            next: null,
            epoch,
            scanned,
            reachedHead: false
        }
        const stable = { ...current, epoch }
        scanned++
        bytes += Buffer.byteLength(JSON.stringify(page.messages), 'utf8')
        for (const message of [...page.messages].reverse()) {
            const text = userText(message)
            if (text === null) continue
            items.push(outlineItem(message.id, text, message.invokedAt ?? message.createdAt, stable))
            if (stopIds.includes(`user-text:${message.id}`)) {
                reachedHead = true; overlapId = `user-text:${message.id}`; break
            }
        }
        next = !reachedHead && page.page.hasMore && page.page.nextBeforeAt !== null && page.page.nextBeforeSeq !== null
            ? {
                kind: 'runner',
                beforeAt: page.page.nextBeforeAt,
                beforeSeq: page.page.nextBeforeSeq,
                epoch
            }
            : null
        if (next?.kind === 'runner' && next.beforeAt === current.beforeAt && next.beforeSeq === current.beforeSeq) throw new Error('Outline history cursor did not advance')
    } while (next && scanned < MAX_PAGES && bytes < MAX_SCAN_BYTES && Date.now() - started < MAX_SCAN_MS)
    return {
        items,
        next,
        scanned,
        epoch,
        reachedHead,
        ...(overlapId ? { overlapId } : {})
    }
}
