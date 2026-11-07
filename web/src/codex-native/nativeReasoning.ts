import type { NativeItemEntry } from './types'

export function nativeReasoningParts(summary: unknown): string[] {
    if (typeof summary === 'string') return [summary]
    return Array.isArray(summary) ? summary.map(part => typeof part === 'string' ? part : '') : []
}

export function nativeReasoningMessageId(itemId: string, index: number): string {
    return index === 0 ? `native:${itemId}` : `native:${itemId}:summary:${index}`
}

/** An incomplete read can overlap the live stream. Keep its longer matching prefix. */
export function reconcileNativeReasoning(current: NativeItemEntry, incoming: NativeItemEntry): NativeItemEntry {
    if (incoming.item.type !== 'reasoning' || current.item.type !== 'reasoning' ||
        incoming.completedAtMs != null || incoming.reasoningStreamCompleted === true) return incoming
    if (current.reasoningStreamCompleted === true) {
        return { ...incoming, ...current, item: current.item }
    }
    const live = nativeReasoningParts(current.item.summary)
    const read = nativeReasoningParts(incoming.item.summary)
    const summary = Array.from({ length: Math.max(live.length, read.length) }, (_, index) => {
        const streamed = live[index] ?? ''
        const received = read[index] ?? ''
        return streamed.startsWith(received) ? streamed : received
    })
    return {
        ...incoming,
        reasoningStreamRevision: current.reasoningStreamRevision,
        item: { ...incoming.item, summary },
    }
}
