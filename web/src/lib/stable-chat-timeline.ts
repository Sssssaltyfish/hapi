import type { ThreadMessageLike } from '@assistant-ui/react'
import { buildVisibleChatBlocks, type VisibleChatBlock, type VisibleChatBlockRole } from '@/chat/toolGroups'

export type TimelineHistoryLocator =
    | { kind: 'runner'; beforeAt: number; beforeSeq: number | null; epoch?: number; targetMessageId: string }
    | { kind: 'native'; turnId: string; itemId: string }

/** Geometry belongs to the list; these descriptors never retain message payloads. */
export type TimelineRow = Readonly<{
    id: string
    role: VisibleChatBlockRole
    sourceIds: readonly string[]
    createdAt: number
    resident: boolean
    current: boolean
    locator?: TimelineHistoryLocator
}>

export type TimelineRowSnapshot = { role: VisibleChatBlockRole; text: string }

export type MaterializedTimelineRow = {
    role: VisibleChatBlockRole
    blocks: readonly VisibleChatBlock[]
    sourceIds: readonly string[]
    createdAt: number
    metadataKey: string
    transient?: boolean
    toolGroupsCollapsed?: boolean
    groupingKey?: string
    project: (id: string, blocks: readonly VisibleChatBlock[], previous?: ThreadMessageLike) => ThreadMessageLike
}

export type TimelineProjection = Readonly<{ message: ThreadMessageLike }>

type CachedProjection = {
    blocks: readonly VisibleChatBlock[]
    metadataKey: string
    projection: TimelineProjection
    bytes: number
    touched: number
    complete: boolean
    project: MaterializedTimelineRow['project']
}

type KnownRow = {
    id: string
    role: VisibleChatBlockRole
    sourceIds: Set<string>
    requiredKeys: Set<string>
    sourceOrder: string[]
    locators: Map<string, TimelineHistoryLocator>
    createdAt: number
    ordinal: number
    locator?: TimelineHistoryLocator
    transient?: boolean
    groupingKey?: string
}

function atomicKeys(blocks: readonly VisibleChatBlock[]): string[] {
    return blocks.flatMap(block => block.kind === 'tool-group'
        ? block.tools.map(tool => `tool-call:${tool.id}`)
        : [`${block.kind}:${block.id}`])
}

function mergeOrderedKeys(previous: readonly string[], incoming: readonly string[]): string[] {
    const order = [...previous]
    for (let index = 0; index < incoming.length; index++) {
        const id = incoming[index]
        if (order.includes(id)) continue
        const following = incoming.slice(index + 1).find(candidate => order.includes(candidate))
        const preceding = incoming.slice(0, index).findLast(candidate => order.includes(candidate))
        if (following) order.splice(order.indexOf(following), 0, id)
        else if (preceding) order.splice(order.indexOf(preceding) + 1, 0, id)
        else order.push(id)
    }
    return order
}

function sameBlocks(a: readonly VisibleChatBlock[], b: readonly VisibleChatBlock[]): boolean {
    return a.length === b.length && a.every((block, index) => {
        const previous = b[index]
        if (block === previous) return true
        // Tool grouping is rebuilt by the bounded reducer even when all tools
        // are unchanged. Compare its small presentation envelope explicitly.
        if (block.kind !== 'tool-group' || previous?.kind !== 'tool-group') return false
        return block.id === previous.id
            && block.defaultOpen === previous.defaultOpen
            && block.historyState === previous.historyState
            && block.activityTitle === previous.activityTitle
            && block.presentationMode === previous.presentationMode
            && block.roundSummary === previous.roundSummary
            && block.tools.length === previous.tools.length
            && block.tools.every((tool, toolIndex) => tool === previous.tools[toolIndex])
    })
}

/** Merge only fragments already proven to share a row by source identity. */
function mergeRowBlocks(previous: readonly VisibleChatBlock[], incoming: readonly VisibleChatBlock[], sourceOrder: readonly string[], toolGroupsCollapsed?: boolean): readonly VisibleChatBlock[] {
    if (previous.length === 0) return incoming
    if (incoming.length === 0) return previous
    if (sameBlocks(previous, incoming)) return previous
    const flatten = (blocks: readonly VisibleChatBlock[]) => blocks.flatMap(block => block.kind === 'tool-group' ? block.tools : [block])
    const old = flatten(previous)
    const next = flatten(incoming)
    const key = (block: VisibleChatBlock) => `${block.kind}:${block.id}`
    const byKey = new Map(old.map(block => [key(block), block]))
    for (const block of next) byKey.set(key(block), block)
    const order = sourceOrder.filter(id => byKey.has(id))
    const groups = incoming.filter(block => block.kind === 'tool-group')
    const previousGroups = previous.filter(block => block.kind === 'tool-group')
    return buildVisibleChatBlocks(order.map(id => byKey.get(id)!), {
        hasMoreMessages: groups[0]?.needsOlderHistory ?? false,
        previousGroups,
        toolGroupsCollapsed: toolGroupsCollapsed ?? !(groups[0]?.defaultOpen ?? previousGroups[0]?.defaultOpen ?? false),
    })
}

/**
 * Session-local logical index, independent of the bounded source window.
 * Only identifiers and history locators survive projection eviction. A sparse
 * segment is never joined to another merely because their timestamps touch.
 */
export class StableChatTimeline {
    private readonly known = new Map<string, KnownRow>()
    private readonly aliases = new Map<string, string>()
    private readonly payloads = new Map<string, CachedProjection>()
    private order: string[] = []
    private clock = 0
    private ordinal = 0
    private rows: readonly TimelineRow[] = []
    private viewportPins = new Set<string>()
    private toolGroupsCollapsed: boolean | undefined

    constructor(private readonly retainedPayloadBytes = 8 * 1024 * 1024) {}

    readonly resolveRowId = (alias: string): string | null => this.aliases.get(alias) ?? null

    /** The measured list updates this without rebuilding any row payload. */
    readonly pinTimelineRows = (ids: readonly string[]): void => {
        this.viewportPins = new Set(ids.flatMap(id => {
            const canonical = this.resolveRowId(id)
            return canonical ? [canonical] : []
        }))
    }

    readonly getRowSnapshot = (alias: string): TimelineRowSnapshot | null => {
        const id = this.resolveRowId(alias)
        const payload = id ? this.payloads.get(id) : undefined
        const row = id ? this.known.get(id) : undefined
        if (!payload?.complete || !row) return null
        const content = payload.projection.message.content
        const text = typeof content === 'string' ? content : content?.flatMap(part => {
            return 'text' in part && typeof part.text === 'string' ? [part.text] : []
        }).join('\n\n') ?? ''
        return { role: row.role, text }
    }

    getRows(): readonly TimelineRow[] { return this.rows }

    update(
        incoming: readonly MaterializedTimelineRow[],
        locators?: ReadonlyMap<string, TimelineHistoryLocator>,
        toolGroupsCollapsed?: boolean,
    ): TimelineProjection[] {
        const locatableAliases = incoming.flatMap(source => source.sourceIds.filter(alias => locators?.has(alias)))
        const hasKnownHistory = [...this.known.values()].some(row => row.locators.size > 0)
        const overlapsKnownHistory = locatableAliases.some(alias => {
            const id = this.aliases.get(alias)
            return id !== undefined && this.known.get(id)?.locators.has(alias)
        })
        if (hasKnownHistory && locatableAliases.length > 0 && !overlapsKnownHistory) {
            // A seek or latest reset can replace the entire source window.
            // Without explicit gap rows, retaining the old segment would imply
            // that its unread intervening history was chronologically adjacent.
            // Only durable history aliases establish overlap: a pending request
            // shared by both windows is not evidence of a contiguous page.
            this.known.clear()
            this.aliases.clear()
            this.payloads.clear()
            this.viewportPins.clear()
            this.order = []
            this.rows = []
            this.clock = 0
            this.ordinal = 0
        }
        const current: string[] = []
        const pinned = new Set<string>()
        for (const source of incoming) {
            const matches = [...new Set(source.sourceIds.flatMap(alias => {
                const id = this.aliases.get(alias)
                const known = id ? this.known.get(id) : undefined
                const sameGroup = known?.groupingKey === source.groupingKey
                    || (known?.groupingKey?.includes(':unclassified:') && source.groupingKey !== undefined)
                return known?.role === source.role && sameGroup ? [known.id] : []
            }))].sort((a, b) => this.known.get(a)!.ordinal - this.known.get(b)!.ordinal)
            let row = matches.length ? this.known.get(matches[0])! : undefined
            if (!row) {
                const base = source.sourceIds[0] ?? `timeline:${this.ordinal}`
                let id = base
                while (this.known.has(id)) id = `${base}~${++this.ordinal}`
                row = { id, role: source.role, groupingKey: source.groupingKey, sourceIds: new Set(), requiredKeys: new Set(), sourceOrder: [], locators: new Map(), createdAt: source.createdAt, ordinal: this.ordinal++, transient: source.transient }
                this.known.set(id, row)
                this.aliases.set(id, id)
            }
            row.groupingKey = source.groupingKey
            // A later contiguous materialization may prove that two previously
            // disconnected fragments belong to one response. The first known
            // identity wins and all old aliases continue to resolve.
            row.sourceOrder = mergeOrderedKeys(row.sourceOrder, atomicKeys(source.blocks))
            const mergedPayloads: CachedProjection[] = []
            for (const mergedId of matches.slice(1)) {
                const merged = this.known.get(mergedId)!
                const payload = this.payloads.get(mergedId)
                if (payload) mergedPayloads.push(payload)
                for (const alias of merged.sourceIds) { row.sourceIds.add(alias); this.aliases.set(alias, row.id) }
                for (const key of merged.requiredKeys) row.requiredKeys.add(key)
                row.sourceOrder = mergeOrderedKeys(row.sourceOrder, merged.sourceOrder)
                for (const [key, locator] of merged.locators) row.locators.set(key, locator)
                this.aliases.set(mergedId, row.id)
                this.known.delete(mergedId)
                this.payloads.delete(mergedId)
                this.order = this.order.filter(id => id !== mergedId)
            }
            for (const alias of source.sourceIds) {
                row.sourceIds.add(alias)
                this.aliases.set(alias, row.id)
                row.locator ??= locators?.get(alias)
                const locator = locators?.get(alias)
                if (locator) row.locators.set(alias, locator)
            }
            if (source.role !== 'assistant') { row.requiredKeys.clear(); row.sourceOrder = atomicKeys(source.blocks) }
            for (const key of atomicKeys(source.blocks)) row.requiredKeys.add(key)
            row.createdAt = Math.min(row.createdAt, source.createdAt)
            row.transient = source.transient
            if (!current.includes(row.id)) current.push(row.id)
            pinned.add(row.id)
            const previous = this.payloads.get(row.id)
            if (previous && mergedPayloads.length === 0 && previous.metadataKey === source.metadataKey && sameBlocks(source.blocks, previous.blocks)) {
                previous.touched = ++this.clock
            } else {
                let blocks = previous?.blocks ?? []
                for (const merged of mergedPayloads) blocks = mergeRowBlocks(blocks, merged.blocks, row.sourceOrder, source.toolGroupsCollapsed)
                blocks = source.role === 'assistant' ? mergeRowBlocks(blocks, source.blocks, row.sourceOrder, source.toolGroupsCollapsed) : source.blocks
                const message = source.project(row.id, blocks, previous?.projection.message ?? mergedPayloads[0]?.projection.message)
                // Count serialized artifacts as well as text: tools and images
                // can carry much larger payloads than their visible labels.
                const serialized = JSON.stringify(message)
                const projection = previous && serialized === JSON.stringify(previous.projection.message)
                    ? previous.projection
                    : { message }
                const bytes = serialized.length * 2
                const available = new Set(atomicKeys(blocks))
                const complete = [...row.requiredKeys].every(key => available.has(key))
                this.payloads.set(row.id, { blocks, metadataKey: source.metadataKey, projection, bytes, touched: ++this.clock, complete, project: source.project })
            }
        }

        if (toolGroupsCollapsed !== undefined && this.toolGroupsCollapsed !== toolGroupsCollapsed) {
            for (const [id, payload] of this.payloads) {
                if (pinned.has(id) || this.known.get(id)?.role !== 'assistant') continue
                const previousGroups = payload.blocks.filter(block => block.kind === 'tool-group')
                const flat = payload.blocks.flatMap(block => block.kind === 'tool-group' ? block.tools : [block])
                const blocks = buildVisibleChatBlocks(flat, {
                    hasMoreMessages: previousGroups[0]?.needsOlderHistory ?? false,
                    previousGroups,
                    toolGroupsCollapsed,
                })
                if (sameBlocks(blocks, payload.blocks)) continue
                const message = payload.project(id, blocks, payload.projection.message)
                payload.blocks = blocks
                payload.projection = { message }
                payload.bytes = JSON.stringify(message).length * 2
            }
        }
        this.toolGroupsCollapsed = toolGroupsCollapsed

        for (const [id, row] of this.known) {
            if (!row.transient || pinned.has(id)) continue
            this.known.delete(id)
            this.payloads.delete(id)
            this.order = this.order.filter(candidate => candidate !== id)
            for (const [alias, target] of this.aliases) if (target === id) this.aliases.delete(alias)
        }

        // Insert around observed neighbors. Existing rows keep their relative
        // order even when their payload was trimmed from the source window.
        for (let index = 0; index < current.length; index++) {
            const id = current[index]
            if (this.order.includes(id)) continue
            const following = current.slice(index + 1).find(candidate => this.order.includes(candidate))
            const preceding = current.slice(0, index).findLast(candidate => this.order.includes(candidate))
            if (following) this.order.splice(this.order.indexOf(following), 0, id)
            else if (preceding) this.order.splice(this.order.indexOf(preceding) + 1, 0, id)
            else {
                const at = this.order.findIndex(candidate => this.known.get(candidate)!.createdAt > this.known.get(id)!.createdAt)
                this.order.splice(at < 0 ? this.order.length : at, 0, id)
            }
        }

        // The active bounded reducer window is pinned. Finished projections
        // outside it use a byte budget; eviction releases block/artifact refs.
        let retainedBytes = 0
        const retained = [...this.payloads.entries()].filter(([id]) => !pinned.has(id) && !this.viewportPins.has(id)).sort((a, b) => b[1].touched - a[1].touched)
        for (const [id, payload] of retained) {
            retainedBytes += payload.bytes
            if (retainedBytes > this.retainedPayloadBytes) this.payloads.delete(id)
        }
        this.rows = this.order.map(id => {
            const row = this.known.get(id)!
            const payload = this.payloads.get(id)
            const available = new Set(atomicKeys(payload?.blocks ?? []))
            const missing = [...row.requiredKeys].find(key => !available.has(key))
            const locator = missing ? row.locators.get(missing) ?? row.locators.get(missing.slice(missing.indexOf(':') + 1)) ?? row.locator : row.locator
            return { id, role: row.role, sourceIds: [...row.sourceIds], createdAt: row.createdAt, resident: payload?.complete === true, current: pinned.has(id), locator }
        })
        return this.order.flatMap(id => {
            const payload = this.payloads.get(id)
            return payload?.complete ? [payload.projection] : []
        })
    }
}

/** Stable callback; changed row metadata creates a new immutable projection. */
export function convertTimelineProjection(source: TimelineProjection): ThreadMessageLike { return source.message }
