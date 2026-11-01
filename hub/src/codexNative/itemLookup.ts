import { record, type NativeRecord } from './transport'

/** Exact daemon-owned content lookup; no copy of native history is retained. */
export async function nativeItemLookup(
    read: (params: NativeRecord) => Promise<unknown>,
    turnId: string,
    itemId: string
): Promise<NativeRecord | null> {
    let response: NativeRecord
    try {
        response = record(await read({ turnId, itemIds: [itemId] }))
    } catch (error) {
        if (error instanceof Error && /no rollout found|turn\b.*\bnot found|unknown turn|item\b.*\bnot found/i.test(error.message)) return null
        throw error
    }
    const entries = Array.isArray(response.data) ? response.data.map(record) : []
    return entries.find(entry => entry.turnId === turnId && record(entry.item).id === itemId) ?? null
}
