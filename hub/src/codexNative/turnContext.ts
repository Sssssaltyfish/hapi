import { record, type NativeRecord } from './transport'

type ItemsPage = {
    data: NativeRecord[]
    nextCursor: string | null
    backwardsCursor: string | null
}

export type TurnContextPage = ItemsPage & {
    newerResumeCursor?: string
}

function page(value: unknown): ItemsPage {
    const result = record(value)
    return {
        data: Array.isArray(result.data) ? result.data.map(record) : [],
        nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null,
        backwardsCursor: typeof result.backwardsCursor === 'string' ? result.backwardsCursor : null
    }
}

function itemId(entry: NativeRecord): unknown {
    return record(entry.item).id
}

function context(desc: ItemsPage, asc: ItemsPage, target: string, resume?: string): TurnContextPage {
    const chronological = [...desc.data].reverse()
    const seen = new Set(chronological.map(itemId))
    for (const entry of asc.data) {
        if (seen.has(itemId(entry))) continue
        seen.add(itemId(entry))
        chronological.push(entry)
    }
    if (!seen.has(target)) throw new Error('The selected turn input is no longer available')
    return {
        data: chronological.reverse(),
        nextCursor: desc.nextCursor,
        backwardsCursor: asc.nextCursor,
        ...(resume ? { newerResumeCursor: resume } : {})
    }
}

/** Only server-issued string cursors are reused without turnId to read across turns. */
export async function nativeTurnContext(
    read: (params: NativeRecord) => Promise<unknown>,
    turnId: string,
    target: string
): Promise<TurnContextPage> {
    const anchor = { type: 'item', itemId: target }
    let after = page(await read({ turnId, cursor: anchor, sortDirection: 'asc', limit: 1 }))
    if (!after.data.length) {
        const last = page(await read({ turnId, sortDirection: 'desc', limit: 1 }))
        if (itemId(last.data[0] ?? {}) !== target) {
            // The turn may have grown between the two reads. Retry its anchor once.
            after = page(await read({ turnId, cursor: anchor, sortDirection: 'asc', limit: 1 }))
            if (!after.data.length) throw new Error('The selected turn changed; retry navigation')
        } else {
            if (!last.backwardsCursor) throw new Error('Native turn navigation did not return a global cursor')
            const resume = last.backwardsCursor
            const asc = page(await read({ cursor: resume, sortDirection: 'asc', limit: 50 }))
            if (!asc.backwardsCursor) {
                return context({ data: [], nextCursor: null, backwardsCursor: null }, asc, target, resume)
            }
            const desc = page(await read({ cursor: asc.backwardsCursor, sortDirection: 'desc', limit: 50 }))
            return context(desc, asc, target, resume)
        }
    }
    if (!after.backwardsCursor) throw new Error('Native turn navigation did not return a global cursor')
    const desc = page(await read({ cursor: after.backwardsCursor, sortDirection: 'desc', limit: 50 }))
    if (!desc.backwardsCursor) {
        if (!desc.data.some(entry => itemId(entry) === target)) {
            throw new Error('The selected turn input is no longer available')
        }
        throw new Error('Native turn navigation did not return a forward cursor; retry navigation')
    }
    const resume = desc.backwardsCursor
    const asc = page(await read({ cursor: resume, sortDirection: 'asc', limit: 50 }))
    return context(desc, asc, target, resume)
}
