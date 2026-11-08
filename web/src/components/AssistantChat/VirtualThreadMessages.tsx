import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type Ref, type RefObject } from 'react'
import { ThreadPrimitive, unstable_useThreadMessageIds } from '@assistant-ui/react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type { TimelineHistoryLocator, TimelineRow } from '@/lib/stable-chat-timeline'
import { captureConversationScrollAnchor, getConversationScrollAnchorPosition, type ConversationScrollAnchor } from '@/lib/conversation-scroll-anchor'

export type EnsureRowOptions = {
    reveal: (viewport: HTMLElement) => boolean
    locate?: (isCurrent: () => boolean) => Promise<boolean>
    ready?: () => boolean
}

export type VirtualThreadHandle = {
    scrollToEnd: (behavior?: ScrollBehavior) => void
    ensureRow: (alias: string, isCurrent?: () => boolean, options?: EnsureRowOptions) => Promise<boolean>
    materializeTurn: (alias: string) => Promise<() => void>
    /** DOM materialization must precede native select-all. Released on selection collapse. */
    materializeSelection: () => Promise<void>
    prepareHistoryEdge: (direction: 'older' | 'newer', isCurrent?: () => boolean) => Promise<boolean>
    hydrateLocator: (locator: TimelineHistoryLocator) => Promise<boolean>
    captureHistoryContentAnchor: () => void
}

type Props = {
    ref: Ref<VirtualThreadHandle>
    viewport: RefObject<HTMLDivElement | null>
    rows?: readonly TimelineRow[]
    resolveRowId?: (alias: string) => string | null
    pinTimelineRows?: (ids: readonly string[]) => void
    onHydrateHistoryRow?: (locator: TimelineHistoryLocator, isCurrent?: () => boolean) => Promise<boolean>
    onHistoryAnchorAdjust?: (scrollTop: number) => void
    components: ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']
    followLatest: RefObject<boolean>
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

export function getTurnRowRange(rows: readonly Pick<TimelineRow, 'role'>[], index: number): [number, number] {
    let start = Math.max(0, index)
    while (start > 0 && rows[start]?.role !== 'user') start -= 1
    let end = Math.max(start, index)
    while (end + 1 < rows.length && rows[end + 1]?.role !== 'user') end += 1
    return [start, end]
}

/** The row registry owns identity; the virtualizer owns all list geometry. */
export function VirtualThreadMessages(props: Props) {
    const messageIds = unstable_useThreadMessageIds()
    const residentIds = useMemo(() => new Set(messageIds), [messageIds])
    const fallbackRows = useMemo<readonly TimelineRow[]>(() => messageIds.map(id => ({ id, role: 'assistant', sourceIds: [id], createdAt: 0, resident: true, current: true })), [messageIds])
    const rows = props.rows ?? fallbackRows
    const containerRef = useRef<HTMLDivElement>(null)
    const lastConnectedViewport = useRef<HTMLDivElement | null>(null)
    const getScrollElement = useCallback(() => {
        const viewport = props.viewport.current
        if (viewport?.isConnected) lastConnectedViewport.current = viewport
        // Compound parent refs can detach and reattach around child layout
        // effects without removing their DOM node. Resetting the virtualizer
        // during that interval drops its keyed prepend anchor.
        return lastConnectedViewport.current?.isConnected ? lastConnectedViewport.current : null
    }, [props.viewport])
    const connectedViewport = getScrollElement()
    const measurements = useRef(new Map<string, number>())
    const measuredRows = useRef(new Map<string, HTMLElement>())
    const pendingRowMeasurements = useRef(new Set<HTMLElement>())
    const rowObserver = useRef<ResizeObserver | null>(null)
    const hydrating = useRef(new Map<string, Promise<boolean>>())
    const hydrationTail = useRef<Promise<void>>(Promise.resolve())
    const hydrationCooldown = useRef(new Map<string, number>())
    const [hydrationRetry, setHydrationRetry] = useState({ key: '', attempt: 0 })
    const [scrollMargin, setScrollMargin] = useState(0)
    // The viewport ref belongs to our parent, whose ref is attached after this
    // child's first layout pass. Enable observation on the following commit.
    const [mounted, setMounted] = useState(false)
    useLayoutEffect(() => { setMounted(true) }, [])
    const [pinned, setPinned] = useState<readonly string[]>([])
    const [navigationAlias, setNavigationAlias] = useState<string | null>(null)
    const pendingNavigation = useRef<{
        alias: string
        isCurrent: () => boolean
        options: EnsureRowOptions
    } | null>(null)
    const [selectionRows, setSelectionRows] = useState<readonly string[]>([])
    const allSelected = useRef(false)
    const semanticAnchor = useRef<{
        anchor: ConversationScrollAnchor
        rowId: string
        sources: Set<string>
        generation: number
        localOffset: number
        observer?: ResizeObserver
        mutations?: MutationObserver
        settleTimer?: ReturnType<typeof setTimeout>
        deadlineTimer?: ReturnType<typeof setTimeout>
    } | null>(null)
    const semanticGeneration = useRef(0)
    const historyMeasurements = useRef<{
        generation: number
        deadline: number
        rows: Map<string, Set<string>>
        anchorRowId?: string
    } | null>(null)
    const navigationGeneration = useRef(0)
    const current = useRef({ rows, props })
    current.current = { rows, props }
    const committed = useRef({ rows, revision: 0 })

    const currentRow = useCallback((alias: string) => {
        const { rows, props } = current.current
        const sourceAlias = alias.startsWith('tool:') ? `tool-call:${alias.slice('tool:'.length)}` : alias
        const id = props.resolveRowId?.(alias) ?? props.resolveRowId?.(sourceAlias) ?? sourceAlias
        return rows.find(row => row.id === id || row.sourceIds.includes(sourceAlias))
    }, [])
    const alignNavigation = useCallback(() => {
        const pending = pendingNavigation.current
        if (!pending?.isCurrent() || !(pending.options.ready?.() ?? true)) return false
        const row = currentRow(pending.alias)
        const viewport = getScrollElement()
        if (!row?.resident || !viewport || !measuredRows.current.get(row.id)?.isConnected) return false
        return pending.options.reveal(viewport)
    }, [currentRow, getScrollElement])

    const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indices = new Set(defaultRangeExtractor(range))
        const retained = new Set([...pinned, ...selectionRows])
        const navigationRow = navigationAlias ? currentRow(navigationAlias) : undefined
        if (navigationRow) retained.add(navigationRow.id)
        rows.forEach((row, index) => { if (retained.has(row.id)) indices.add(index) })
        return [...indices].sort((a, b) => a - b)
    }, [pinned, selectionRows, rows, navigationAlias, currentRow])
    const virtualizer = useVirtualizer({
        count: rows.length,
        enabled: mounted,
        getScrollElement,
        estimateSize: index => measurements.current.get(rows[index]!.id) ?? 180,
        getItemKey: index => rows[index]!.id,
        overscan: 6,
        scrollMargin,
        anchorTo: 'end',
        followOnAppend: props.followLatest.current,
        scrollEndThreshold: 1,
        rangeExtractor,
        // Resize notifications can let React batch renders. The layout effect
        // below still measures newly committed rows before paint.
        useFlushSync: false,
    })
    const measureRow = useCallback((element: HTMLElement, entry?: ResizeObserverEntry) => {
        const id = element.dataset.hapiVirtualRow
        const index = Number(element.dataset.index)
        if (!id || measuredRows.current.get(id) !== element || !element.isConnected || element.dataset.hapiRowResident !== 'true'
            || !Number.isInteger(index) || current.current.rows[index]?.id !== id) return
        const height = entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height
        if (height <= 0) return
        measurements.current.set(id, height)
        if (pendingNavigation.current) {
            const previous = virtualizer.shouldAdjustScrollPositionOnItemSizeChange
            virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
            try { virtualizer.resizeItem(index, height) } finally {
                virtualizer.shouldAdjustScrollPositionOnItemSizeChange = previous
            }
            return
        }
        const history = historyMeasurements.current
        const previousSources = history?.generation === semanticGeneration.current && history.deadline > Date.now()
            ? history.rows.get(id) : undefined
        const expandedByHistory = previousSources && current.current.rows[index]!.sourceIds.some(source => !previousSources.has(source))
        const previousItem = expandedByHistory ? virtualizer.getVirtualItems().find(item => item.key === id) : undefined
        const anchorRowId = history?.anchorRowId
            ? current.current.props.resolveRowId?.(history.anchorRowId) ?? history.anchorRowId : undefined
        const anchorIndex = anchorRowId ? current.current.rows.findIndex(row => row.id === anchorRowId) : -1
        const viewportTop = virtualizer.scrollElement?.scrollTop ?? virtualizer.scrollOffset ?? 0
        const beforeReadingPoint = anchorIndex >= 0 ? index < anchorIndex : previousItem && previousItem.end <= viewportTop
        if (previousItem && beforeReadingPoint) {
            // Native upward scrolling normally suppresses remeasurement
            // correction. A history-expanded predecessor must preserve the
            // captured reading point even if part of that row is still visible.
            // Without a precise content anchor, retain the above-fold fallback.
            const previous = virtualizer.shouldAdjustScrollPositionOnItemSizeChange
            virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => true
            try { virtualizer.resizeItem(index, height) } finally {
                virtualizer.shouldAdjustScrollPositionOnItemSizeChange = previous
            }
            return
        }
        // Own one measurement channel per row. Unlike measureElement's ref
        // path, resizeItem does not postpone first measurement during a fling.
        virtualizer.resizeItem(index, height)
    }, [virtualizer])
    const attachMeasuredRow = useCallback((element: HTMLElement | null) => {
        if (!element) return
        const id = element.dataset.hapiVirtualRow
        if (!id) return
        const previous = measuredRows.current.get(id)
        if (previous && previous !== element) {
            pendingRowMeasurements.current.delete(previous)
            rowObserver.current?.unobserve(previous)
        }
        measuredRows.current.set(id, element)
        pendingRowMeasurements.current.add(element)
        rowObserver.current?.observe(element, { box: 'border-box' })
        return () => {
            pendingRowMeasurements.current.delete(element)
            rowObserver.current?.unobserve(element)
            if (measuredRows.current.get(id) === element) measuredRows.current.delete(id)
        }
    }, [])
    useLayoutEffect(() => {
        const observer = new ResizeObserver(entries => {
            for (const entry of entries) if (entry.target instanceof HTMLElement) measureRow(entry.target, entry)
            alignNavigation()
        })
        rowObserver.current = observer
        for (const element of measuredRows.current.values()) observer.observe(element, { box: 'border-box' })
        return () => { observer.disconnect(); rowObserver.current = null }
    }, [measureRow, alignNavigation])
    // Measure new rows and timeline changes before paint, including during touch
    // inertia. Size-only updates to retained rows are handled by ResizeObserver.
    useLayoutEffect(() => {
        const rowsToMeasure = committed.current.rows !== rows ? measuredRows.current.values() : pendingRowMeasurements.current
        committed.current = { rows, revision: committed.current.revision + 1 }
        for (const element of rowsToMeasure) measureRow(element)
        pendingRowMeasurements.current.clear()
        // The retained target is measured in normal flow before its semantic
        // destination is aligned. No row-start scroll is needed to mount it.
        alignNavigation()
    })
    useLayoutEffect(() => {
        if (mounted && props.followLatest.current) virtualizer.scrollToEnd()
    }, [mounted, props.followLatest, virtualizer])
    const clearSemanticAnchor = useCallback(() => {
        const pending = semanticAnchor.current
        pending?.observer?.disconnect()
        pending?.mutations?.disconnect()
        clearTimeout(pending?.settleTimer)
        clearTimeout(pending?.deadlineTimer)
        semanticAnchor.current = null
    }, [])
    const refineSemanticAnchor = useCallback(() => {
        const pending = semanticAnchor.current
        if (!pending || semanticGeneration.current !== pending.generation) return
        const row = currentRow(pending.rowId)
        // Whole-row prepends belong to TanStack. Only a historical source
        // extension inside this retained response needs content refinement.
        if (!row || !row.sourceIds.some(source => !pending.sources.has(source))) return
        const viewport = getScrollElement()
        if (!viewport) return
        const element = measuredRows.current.get(row.id)
        const position = getConversationScrollAnchorPosition(viewport, pending.anchor)
        if (!element?.isConnected || !position) return
        const rowTop = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        const localOffset = position.currentOffset - rowTop
        const delta = localOffset - pending.localOffset
        pending.localOffset = localOffset
        // Native inertia moves the row and its text together. Only a change
        // inside the row is a layout correction; replaying viewport coordinates
        // here would cancel the reader's movement on every later observer.
        if (Math.abs(delta) > 0.5) {
            virtualizer.cancelScroll()
            viewport.scrollTop += delta
            current.current.props.onHistoryAnchorAdjust?.(viewport.scrollTop)
        }
        // AUI can commit content after its row descriptor. Keep watching the
        // affected row until its geometry settles, with a separate hard bound.
        if (!pending.settleTimer || Math.abs(delta) > 0.5) {
            clearTimeout(pending.settleTimer)
            pending.settleTimer = setTimeout(() => {
                if (semanticAnchor.current === pending) clearSemanticAnchor()
            }, 250)
        }
    }, [currentRow, getScrollElement, virtualizer, clearSemanticAnchor])
    const captureHistoryContentAnchor = useCallback(() => {
        const viewport = getScrollElement()
        if (!viewport || current.current.props.followLatest.current || pendingNavigation.current) return
        clearSemanticAnchor()
        const generation = ++semanticGeneration.current
        historyMeasurements.current = {
            generation,
            deadline: Date.now() + 5000,
            rows: new Map([...measuredRows.current.keys()].flatMap(id => {
                const row = currentRow(id)
                return row ? [[id, new Set(row.sourceIds)] as const] : []
            })),
        }
        const anchor = captureConversationScrollAnchor(viewport)
        if (!anchor || anchor.kind !== 'content') return
        const row = currentRow(anchor.id)
        if (!row) return
        const element = [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-hapi-virtual-row]') ?? [])].find(element => element.dataset.hapiVirtualRow === row.id)
        if (!element) return
        if (historyMeasurements.current) historyMeasurements.current.anchorRowId = row.id
        const rowTop = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        const pending: NonNullable<typeof semanticAnchor.current> = {
            // This local baseline belongs to this exact source point. A fallback
            // in a different row must never inherit its row-relative geometry.
            anchor: { ...anchor, alternatives: undefined }, rowId: row.id,
            sources: new Set(row.sourceIds), generation, localOffset: anchor.topOffset - rowTop,
        }
        semanticAnchor.current = pending
        if (element && typeof ResizeObserver !== 'undefined') {
            pending.observer = new ResizeObserver(refineSemanticAnchor)
            pending.observer.observe(element)
        }
        if (element && typeof MutationObserver !== 'undefined') {
            // AUI leaf commits can occur after this list's layout effect. Read
            // their actual geometry in the commit microtask, before the next
            // animation frame; ResizeObserver also covers later layout growth.
            pending.mutations = new MutationObserver(refineSemanticAnchor)
            pending.mutations.observe(element, { childList: true, characterData: true, subtree: true })
        }
        pending.deadlineTimer = setTimeout(() => { if (semanticAnchor.current === pending) clearSemanticAnchor() }, 5000)
    }, [currentRow, getScrollElement, clearSemanticAnchor, refineSemanticAnchor])
    const demand = useCallback((row: TimelineRow, requireSource = false, isCurrent: () => boolean = () => true): Promise<boolean> => {
        const latest = currentRow(row.id) ?? row
        if (requireSource ? latest.current : latest.resident) return Promise.resolve(true)
        if (!latest.locator || !current.current.props.onHydrateHistoryRow) return Promise.resolve(false)
        const key = `${requireSource ? 'source:' : ''}${latest.id}:${JSON.stringify(latest.locator)}`
        const pending = hydrating.current.get(key)
        if (pending) return pending
        if ((hydrationCooldown.current.get(key) ?? 0) > Date.now()) return Promise.resolve(false)
        // Capture ownership when the request is created, including a pin's
        // range effect. Joining an existing background request keeps its owner.
        const navigation = pendingNavigation.current
        const canApply = () => isCurrent() && (!navigation || navigation.isCurrent())
        // Native seeks replace the source window. All demand paths share one
        // queue so outline, selection and range fetches cannot cancel each other.
        const request = hydrationTail.current.then(async () => {
            if (!canApply()) return false
            const source = currentRow(latest.id)
            if (!source || (requireSource ? source.current : source.resident)) return true
            const hydrate = current.current.props.onHydrateHistoryRow
            if (!source.locator || !hydrate) return false
            try {
                captureHistoryContentAnchor()
                const loaded = await hydrate(source.locator, canApply)
                if (!loaded) hydrationCooldown.current.set(key, Date.now() + 1000)
                return loaded
            } catch {
                hydrationCooldown.current.set(key, Date.now() + 1000)
                return false
            }
        }).finally(() => hydrating.current.delete(key))
        hydrationTail.current = request.then(() => {})
        hydrating.current.set(key, request)
        return request
    }, [currentRow, captureHistoryContentAnchor])
    const findIndex = useCallback((alias: string) => {
        const { rows, props } = current.current
        alias = alias.startsWith('hapi-message-') ? alias.slice('hapi-message-'.length) : alias
        const sourceAlias = alias.startsWith('tool:') ? `tool-call:${alias.slice('tool:'.length)}` : alias
        const id = props.resolveRowId?.(alias) ?? props.resolveRowId?.(sourceAlias) ?? sourceAlias
        return rows.findIndex(row => row.id === id || row.sourceIds.includes(sourceAlias))
    }, [])

    const hydrateRowFully = useCallback(async (alias: string, isCurrent: () => boolean = () => true) => {
        // A response can span several history pages. Each successful page may
        // expose a new missing-piece locator; consume it until the row is whole.
        for (let attempt = 0; attempt < 24 && isCurrent(); attempt++) {
            const row = currentRow(alias)
            if (!row) return false
            if (row.resident) return true
            const locator = JSON.stringify(row.locator)
            if (!await demand(row)) return false
            for (let settle = 0; settle < 12 && isCurrent(); settle++) {
                await frame()
                const next = currentRow(alias)
                if (!next) return false
                if (next.resident) return true
                if (JSON.stringify(next.locator) !== locator) break
                if (settle === 11) return false
            }
        }
        return false
    }, [currentRow, demand])

    const ensureRow = useCallback(async (alias: string, isCurrent: () => boolean = () => true, options?: EnsureRowOptions) => {
            const generation = ++navigationGeneration.current
            const canNavigate = () => generation === navigationGeneration.current && isCurrent()
            pendingNavigation.current = null
            setNavigationAlias(null)
            if (options) {
                virtualizer.cancelScroll()
                clearSemanticAnchor()
                semanticGeneration.current++
                historyMeasurements.current = null
                const pending = { alias, isCurrent: canNavigate, options }
                // Register before a locator fetch can commit new rows. A far
                // target mounts through the same normal-flow range extractor.
                pendingNavigation.current = pending
                setNavigationAlias(alias)
                try {
                    if (!currentRow(alias) && (!options.locate || !await options.locate(canNavigate))) return false
                    const deadline = Date.now() + 10_000
                    while (!currentRow(alias) && canNavigate() && Date.now() < deadline) await frame()
                    if (!canNavigate() || !currentRow(alias)) return false
                    if (!await hydrateRowFully(alias, canNavigate)) return false
                    let alignedFrames = 0
                    while (canNavigate() && Date.now() < deadline) {
                        const index = findIndex(alias)
                        if (index < 0) return false
                        const aligned = alignNavigation()
                        const range = virtualizer.range
                        // Release the extra row only after the real viewport
                        // range has taken ownership of its mounted content.
                        if (aligned && range && range.startIndex <= index && range.endIndex >= index) {
                            if (++alignedFrames >= 2) return true
                        } else alignedFrames = 0
                        await frame()
                    }
                    return false
                } finally {
                    if (pendingNavigation.current === pending) {
                        pendingNavigation.current = null
                        setNavigationAlias(null)
                    }
                }
            }
            const index = findIndex(alias)
            if (index < 0 || !canNavigate()) return false
            virtualizer.scrollToIndex(index, { align: 'start' })
            if (!await hydrateRowFully(current.current.rows[index]!.id, canNavigate)) return false
            const deadline = Date.now() + 10_000
            while (canNavigate() && Date.now() < deadline) {
                const nextIndex = findIndex(alias)
                if (nextIndex < 0) return false
                virtualizer.scrollToIndex(nextIndex, { align: 'start' })
                await frame()
                if (!canNavigate()) return false
                if (current.current.rows[nextIndex]?.resident && containerRef.current?.querySelector(`[data-index="${nextIndex}"] [data-hapi-message-role]`)) {
                    // Index navigation is complete. Its numeric-index command
                    // must not reconcile against different rows after prepend.
                    virtualizer.cancelScroll()
                    return true
                }
            }
            return false
        }, [hydrateRowFully, findIndex, virtualizer, currentRow, alignNavigation, clearSemanticAnchor])
    const materializeSelection = useCallback(async () => {
        allSelected.current = true
        setPinned(current.current.rows.filter(row => row.resident).map(row => row.id))
        await frame()
        await frame()
    }, [])
    useImperativeHandle(props.ref, () => ({
        scrollToEnd: (behavior = 'auto') => {
            navigationGeneration.current++
            pendingNavigation.current = null
            setNavigationAlias(null)
            virtualizer.scrollToEnd({ behavior })
        },
        captureHistoryContentAnchor,
        hydrateLocator: locator => {
            const request = hydrationTail.current.then(async () => {
                try { return await current.current.props.onHydrateHistoryRow?.(locator) ?? false } catch { return false }
            })
            hydrationTail.current = request.then(() => {}, () => {})
            return request
        },
        prepareHistoryEdge: async (direction, isCurrent = () => true) => {
            const rows = current.current.rows
            const locatable = rows.filter(row => row.locator)
            const row = direction === 'newer' ? locatable.at(-1) : locatable[0]
            if (!row || row.current) return true
            const revision = committed.current.revision
            if (!await demand(row, true, isCurrent)) return false
            const deadline = Date.now() + 5000
            while (isCurrent() && Date.now() < deadline) {
                await frame()
                const id = current.current.props.resolveRowId?.(row.id) ?? row.id
                if (committed.current.revision > revision && committed.current.rows.some(candidate => candidate.id === id && candidate.current)) {
                    await frame()
                    return isCurrent()
                }
            }
            return false
        },
        ensureRow,
        materializeTurn: async alias => {
            const index = findIndex(alias)
            if (index < 0) return () => {}
            const [start, end] = getTurnRowRange(current.current.rows, index)
            const turnRows = current.current.rows.slice(start, end + 1)
            setPinned(turnRows.map(row => row.id))
            // Sequential hydration preserves the existing bounded fetch controller.
            try {
                for (const row of turnRows) {
                    if (!await hydrateRowFully(row.id)) throw new Error('Unable to load the complete conversation turn')
                }
                await frame()
                await frame()
            } catch (error) {
                setPinned([])
                throw error
            }
            return () => setPinned([])
        },
        materializeSelection,
    }), [demand, hydrateRowFully, findIndex, virtualizer, ensureRow, captureHistoryContentAnchor, materializeSelection])

    useLayoutEffect(() => { refineSemanticAnchor() }, [rows, refineSemanticAnchor])
    useEffect(() => clearSemanticAnchor, [clearSemanticAnchor])
    useEffect(() => () => {
        navigationGeneration.current++
        pendingNavigation.current = null
    }, [])

    useLayoutEffect(() => {
        const container = containerRef.current
        const viewport = getScrollElement()
        if (!container || !viewport) return
        let width = container.getBoundingClientRect().width
        const update = () => {
            setScrollMargin(container.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop)
            const nextWidth = container.getBoundingClientRect().width
            if (Math.abs(width - nextWidth) > 1) {
                width = nextWidth
                for (const element of measuredRows.current.values()) pendingRowMeasurements.current.add(element)
                measurements.current.clear()
                virtualizer.measure()
            }
        }
        update()
        const observer = new ResizeObserver(update)
        observer.observe(container)
        return () => observer.disconnect()
    }, [connectedViewport, virtualizer, mounted])

    useEffect(() => {
        const onSelection = () => {
            const selection = window.getSelection()
            if (!selection || selection.isCollapsed) {
                setSelectionRows(previous => previous.length ? [] : previous)
                if (allSelected.current) { allSelected.current = false; setPinned([]) }
                return
            }
            const rowIndex = (node: Node | null) => {
                const element = node instanceof Element ? node : node?.parentElement
                const row = element?.closest<HTMLElement>('[data-hapi-virtual-row]')
                return row && containerRef.current?.contains(row) ? Number(row.dataset.index) : null
            }
            const anchor = rowIndex(selection.anchorNode)
            const focus = rowIndex(selection.focusNode)
            if (anchor !== null && focus !== null) {
                const selected = current.current.rows.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1).map(row => row.id)
                setSelectionRows(previous => previous.length === selected.length && previous.every((id, index) => id === selected[index]) ? previous : selected)
            }
        }
        document.addEventListener('selectionchange', onSelection)
        const viewport = props.viewport.current
        const selectAll = (event: Event) => {
            const callback = (event as CustomEvent<() => void>).detail
            void materializeSelection().then(() => callback?.())
        }
        viewport?.addEventListener('hapi:materialize-selection', selectAll)
        const reveal = (event: Event) => {
            const detail = (event as CustomEvent<{ alias: string; complete: (found: boolean) => void }>).detail
            if (detail?.alias) void ensureRow(detail.alias).then(detail.complete, () => detail.complete(false))
        }
        viewport?.addEventListener('hapi:ensure-row', reveal)
        const interrupt = (event: Event) => {
            if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
            virtualizer.cancelScroll()
            navigationGeneration.current++
            pendingNavigation.current = null
            setNavigationAlias(null)
            semanticGeneration.current++
            historyMeasurements.current = null
            clearSemanticAnchor()
        }
        viewport?.addEventListener('wheel', interrupt, { passive: true })
        viewport?.addEventListener('touchstart', interrupt, { passive: true })
        viewport?.addEventListener('pointerdown', interrupt, { passive: true })
        viewport?.addEventListener('keydown', interrupt)
        return () => {
            document.removeEventListener('selectionchange', onSelection)
            viewport?.removeEventListener('hapi:materialize-selection', selectAll)
            viewport?.removeEventListener('hapi:ensure-row', reveal)
            viewport?.removeEventListener('wheel', interrupt)
            viewport?.removeEventListener('touchstart', interrupt)
            viewport?.removeEventListener('pointerdown', interrupt)
            viewport?.removeEventListener('keydown', interrupt)
        }
    }, [demand, props.viewport, ensureRow, virtualizer, clearSemanticAnchor, materializeSelection])

    const items = virtualizer.getVirtualItems()
    // Payload requests follow the virtual range, including retained empty rows.
    // Physical scroll edges only discover history not yet present in the index.
    useEffect(() => {
        props.pinTimelineRows?.(items.map(item => rows[item.index]!.id))
        const center = ((virtualizer.range?.startIndex ?? 0) + (virtualizer.range?.endIndex ?? 0)) / 2
        const missing = [...items].sort((a, b) => Math.abs(a.index - center) - Math.abs(b.index - center))
            .map(item => rows[item.index]!).filter(row => !row.resident)
        const retryKey = missing.map(row => `${row.id}:${JSON.stringify(row.locator)}`).join('|')
        const retryAttempt = hydrationRetry.key === retryKey ? hydrationRetry.attempt : 0
        let cancelled = false
        let retryTimer: ReturnType<typeof setTimeout> | undefined
        void (async () => {
            for (const row of missing) {
                if (cancelled) return
                if (!await hydrateRowFully(row.id, () => !cancelled)) {
                    if (!cancelled && retryAttempt < 3) retryTimer = setTimeout(() => setHydrationRetry({ key: retryKey, attempt: retryAttempt + 1 }), 1000 * (retryAttempt + 1))
                    break
                }
            }
        })()
        return () => { cancelled = true; clearTimeout(retryTimer); props.pinTimelineRows?.([]) }
    }, [items, rows, hydrateRowFully, props.pinTimelineRows, hydrationRetry])

    // Normal-flow spacers preserve native text selection across adjacent rows.
    // Non-contiguous pinned rows each receive their own exact geometry gap.
    let previousEnd = scrollMargin
    return <div ref={containerRef} className="happy-thread-messages" data-hapi-virtualized="true" data-hapi-logical-row-count={rows.length}>
        {items.map(item => {
            const row = rows[item.index]!
            const gap = Math.max(0, item.start - previousEnd)
            previousEnd = item.end
            const resident = row.resident && residentIds.has(row.id)
            return <div key={row.id} style={{ display: 'contents' }}>
                {gap > 0 ? <div aria-hidden="true" data-hapi-virtual-spacer="true" style={{ height: gap }} /> : null}
                <div data-index={item.index} data-hapi-virtual-row={row.id}
                    data-hapi-row-resident={resident ? 'true' : 'false'} data-hapi-row-size={item.size}
                    ref={resident ? attachMeasuredRow : undefined}
                    style={resident ? { paddingBottom: 12, overflowAnchor: 'none' } : { height: item.size, overflowAnchor: 'none' }}>
                    {resident ? <ThreadPrimitive.Unstable_MessageById messageId={row.id} components={props.components} /> : <div aria-hidden="true" className="h-full min-h-1 animate-pulse rounded-md bg-[var(--app-subtle-bg)]/30" />}
                </div>
            </div>
        })}
        <div aria-hidden="true" data-hapi-virtual-spacer="true" style={{ height: Math.max(0, virtualizer.getTotalSize() - (previousEnd - scrollMargin)) }} />
    </div>
}
