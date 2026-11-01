import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { codexInputDisplayText } from '@hapi/protocol'
import type { DecryptedMessage } from '@hapi/protocol/types'
import type { MessagesResponse } from '@hapi/protocol/apiTypes'
import { record, type NativeRecord } from '../codexNative/transport'

export type OutlineContinuation =
    | {
        kind: 'native-turns'
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
    historyPage?: Extract<OutlineContinuation, { kind: 'runner' }>
    indexPage?: OutlineContinuation
    nativeTurn?: { turnId: string; itemId: string }
}
export type OutlinePage = {
    items: OutlineItem[]
    next: OutlineContinuation | null
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
    const text = codexInputDisplayText(value).replace(/\s+/g, ' ').trim()
    return text.length > 96 ? `${text.slice(0, 93).trimEnd()}...` : text || 'Empty message'
}
function outlineItem(id: string, text: string, at: number, locator: OutlineContinuation): OutlineItem {
    return {
        id: `outline:user-text:${id}`,
        targetMessageId: `user-text:${id}`,
        kind: 'user',
        label: preview(text),
        createdAt: at,
        ...(locator.kind === 'runner' ? { historyPage: locator } : { indexPage: locator })
    }
}
function userText(message: DecryptedMessage): string | null {
    const envelope = unwrapRoleWrappedRecordEnvelope(message.content)
    if (envelope?.role !== 'user' || message.invokedAt === null) return null
    const content = envelope.content
    return typeof content === 'string' ? content : typeof record(content).text === 'string' ? record(content).text as string : null
}

function turnTimestamp(turn: NativeRecord): number {
    if (typeof turn.startedAt === 'number' && Number.isFinite(turn.startedAt)) return turn.startedAt * 1000
    // Native Turn documents Codex-generated IDs as UUIDv7. RFC 9562 §5.7
    // defines its first 48 bits as Unix milliseconds; other ID formats stay opaque.
    const uuid = typeof turn.id === 'string'
        ? /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(turn.id)
        : null
    if (uuid) return Number.parseInt(uuid[1] + uuid[2], 16)
    return typeof turn.completedAt === 'number' && Number.isFinite(turn.completedAt) ? turn.completedAt * 1000 : 0
}

/** The Native directory follows turn summaries; steering input stays in the body. */
export async function nativeOutlinePage(
    read: (params: NativeRecord) => Promise<unknown>,
    cursor: string | null,
    stopIds: string[] = [],
): Promise<OutlinePage> {
    const scanUntil = Date.now() + MAX_SCAN_MS
    const items: OutlineItem[] = []
    let next: OutlineContinuation | null = { kind: 'native-turns', cursor }
    let scanned = 0
    let bytes = 0
    let reachedHead = false
    let overlapId: string | undefined
    do {
        const locator: OutlineContinuation = { kind: 'native-turns', cursor }
        // A started page retains the normal RPC timeout. The scan budget only
        // decides whether to request another page after this one completes.
        const page = record(await read({ cursor: cursor ?? undefined, limit: 50, sortDirection: 'desc', itemsView: 'summary' }))
        bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
        scanned++
        for (const raw of Array.isArray(page.data) ? page.data : []) {
            const turn = record(raw)
            const item = record(Array.isArray(turn.items)
                ? turn.items.find(value => record(value).type === 'userMessage')
                : undefined)
            if (typeof turn.id !== 'string' || typeof item.id !== 'string') continue
            const id = `native:${String(item.id)}`
            const content = item.content ?? item.input
            const text = Array.isArray(content) ? content.map(value => {
                const part = record(value)
                if (typeof part.text === 'string') return part.text
                if (part.type === 'mention') return ''
                return part.type === 'image' ? '[Image]' : part.type ? `[${String(part.type)}: ${String(part.path ?? part.name ?? '')}]` : ''
            }).filter(Boolean).join('\n') : typeof content === 'string' ? content : ''
            if (text) {
                const at = turnTimestamp(turn)
                items.push({
                    ...outlineItem(id, text, at, locator),
                    nativeTurn: { turnId: turn.id, itemId: item.id }
                })
            }
            // Include the boundary so an accepted/edited user item can refresh its preview.
            if (stopIds.includes(`user-text:${id}`)) {
                reachedHead = true; overlapId = `user-text:${id}`; break
            }
        }
        const after = typeof page.nextCursor === 'string' ? page.nextCursor : null
        if (after && after === cursor) throw new Error('Outline history cursor did not advance')
        cursor = after
        next = !reachedHead && after ? { kind: 'native-turns', cursor: after } : null
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
    read: (locator: Extract<OutlineContinuation, {
        kind: 'runner'
    }>) => MessagesResponse,
    locator: Extract<OutlineContinuation, {
        kind: 'runner'
    }>,
    stopIds: string[] = [],
): OutlinePage {
    const started = Date.now()
    const items: OutlineItem[] = []
    let next: OutlineContinuation | null = locator
    let scanned = 0
    let bytes = 0
    let epoch = locator.epoch
    let reachedHead = false
    let overlapId: string | undefined
    do {
        const current = next as Extract<OutlineContinuation, {
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
