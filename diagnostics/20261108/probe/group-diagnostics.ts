export async function installGroupDiagnostics(page: any) {
    await page.addInitScript(() => {
        const diagnostic: any = { active: false, stats: {}, expensive: [], reasoningShapes: [] }
        function label(element: Element | null): string {
            if (!element) return 'unknown'
            if (element.hasAttribute('data-hapi-virtual-row')) return 'virtual-row'
            if (element.hasAttribute('data-hapi-thread-viewport')) return 'thread-viewport'
            if (element.closest('[data-hapi-scroll-anchor^="agent-reasoning:"]')) return 'native-reasoning'
            if (element.closest('[data-hapi-scroll-anchors]')) return 'tool-group'
            if (element.closest('.happy-thread-messages')) return 'thread-content'
            return element.tagName.toLowerCase()
        }
        function record(type: string, target: string, started: number) {
            const duration = performance.now() - started
            const key = `${type}:${target}`
            const total = diagnostic.stats[key] ??= { count: 0, duration: 0, max: 0 }
            total.count++
            total.duration += duration
            total.max = Math.max(total.max, duration)
            if (duration >= 10) {
                diagnostic.expensive.push({ type, target, start: started, duration, stack: new Error().stack?.split('\n').slice(2, 12) })
            }
        }
        const rect = Element.prototype.getBoundingClientRect
        Element.prototype.getBoundingClientRect = function () {
            if (!diagnostic.active) return rect.call(this)
            const started = performance.now()
            const result = rect.call(this)
            record('getBoundingClientRect', label(this), started)
            return result
        }
        const rangeRect = Range.prototype.getBoundingClientRect
        Range.prototype.getBoundingClientRect = function () {
            if (!diagnostic.active) return rangeRect.call(this)
            const started = performance.now()
            const result = rangeRect.call(this)
            record('Range.getBoundingClientRect', 'range', started)
            return result
        }
        for (const [prototype, property] of [[Element.prototype, 'scrollHeight'], [HTMLElement.prototype, 'offsetHeight'], [Element.prototype, 'scrollTop']] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
            if (!descriptor?.get) continue
            Object.defineProperty(prototype, property, {
                ...descriptor,
                get() {
                    if (!diagnostic.active) return descriptor.get!.call(this)
                    const started = performance.now()
                    const result = descriptor.get!.call(this)
                    record(`${property}.get`, label(this), started)
                    return result
                },
                set: descriptor.set && function (this: Element, value: unknown) {
                    if (!diagnostic.active) return descriptor.set!.call(this, value)
                    const started = performance.now()
                    descriptor.set!.call(this, value)
                    record(`${property}.set`, label(this), started)
                },
            })
        }
        const scrollTo = Element.prototype.scrollTo
        Element.prototype.scrollTo = function (...args: [any, any?]) {
            if (!diagnostic.active) return (scrollTo as any).apply(this, args)
            const started = performance.now()
            ;(scrollTo as any).apply(this, args)
            record('scrollTo', label(this), started)
        }
        const OriginalObserver = window.ResizeObserver
        window.ResizeObserver = class extends OriginalObserver {
            constructor(callback) {
                super((entries, observer) => {
                    if (!diagnostic.active) return callback(entries, observer)
                    const started = performance.now()
                    const targets = [...new Set(entries.map(entry => label(entry.target)))].sort().join(',')
                    callback(entries, observer)
                    record('ResizeObserver', targets, started)
                })
            }
        }
        diagnostic.start = (panelId: string) => {
            diagnostic.active = true
            document.addEventListener('click', () => {
                diagnostic.clickAt = performance.now()
                performance.mark('hapi-expand-diagnostic-click')
            }, { capture: true, once: true })
            const mutation = new MutationObserver(() => {
                const inline = document.querySelectorAll('[data-hapi-native-reasoning="inline"]').length
                const disclosure = document.querySelectorAll('[data-hapi-native-reasoning="disclosure"]').length
                const panelOpen = document.getElementById(panelId)?.hasAttribute('data-open') === true
                if (panelOpen && diagnostic.openAt === undefined) {
                    diagnostic.openAt = performance.now()
                    performance.mark('hapi-expand-diagnostic-panel-open')
                }
                const previous = diagnostic.reasoningShapes.at(-1)
                if (previous?.inline !== inline || previous.disclosure !== disclosure || previous.panelOpen !== panelOpen) diagnostic.reasoningShapes.push({ at: performance.now(), inline, disclosure, panelOpen })
            })
            mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hapi-native-reasoning', 'data-open'] })
            diagnostic.stop = () => {
                diagnostic.active = false
                mutation.disconnect()
                performance.mark('hapi-expand-diagnostic-end')
                return { clickAt: diagnostic.clickAt, openAt: diagnostic.openAt, stats: diagnostic.stats, expensive: diagnostic.expensive, reasoningShapes: diagnostic.reasoningShapes }
            }
        }
        ;(window as any).__groupDiagnostic = diagnostic
    })
}

export async function startLayoutTrace(cdp: any) {
    await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.stack',
        transferMode: 'ReturnAsStream',
    })
}

export async function stopLayoutTrace(cdp: any) {
    const complete = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end')
    const { stream } = await complete
    const chunks = []
    while (true) {
        const chunk = await cdp.send('IO.read', { handle: stream })
        chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data)
        if (chunk.eof) break
    }
    await cdp.send('IO.close', { handle: stream })
    const events: any[] = JSON.parse(chunks.join('')).traceEvents
    const click = events.find(event => event.name === 'hapi-expand-diagnostic-click')
    const panelOpen = events.find(event => event.name === 'hapi-expand-diagnostic-panel-open')
    const end = events.find(event => event.name === 'hapi-expand-diagnostic-end')
    const kinds = new Set(['Layout', 'UpdateLayoutTree', 'FunctionCall', 'FireAnimationFrame', 'EventDispatch', 'TimerFire'])
    const interesting = events.filter(event => event.dur > 0 && kinds.has(event.name) && (!click || (event.pid === click.pid && event.tid === click.tid && event.ts + event.dur >= click.ts && (!end || event.ts < end.ts))))
    const totals = interesting.reduce((totals, event) => {
        const record = totals[event.name] ??= { count: 0, durationMs: 0, maxMs: 0 }
        record.count++
        record.durationMs += event.dur / 1000
        record.maxMs = Math.max(record.maxMs, event.dur / 1000)
        return totals
    }, {})
    const layout = interesting.filter(event => event.name === 'Layout')
    const stat = (events: any[]) => ({ count: events.length, totalMs: events.reduce((sum, event) => sum + event.dur / 1000, 0), maxMs: Math.max(0, ...events.map(event => event.dur / 1000)) })
    const firstLayout = layout.find(event => event.dur >= 50_000)
    return {
        clickTimestamp: click?.ts, panelOpenTimestamp: panelOpen?.ts, endTimestamp: end?.ts, totals,
        phases: panelOpen && {
            beforeOpen: stat(layout.filter(event => event.ts < panelOpen.ts)),
            first500MsAfterOpen: stat(layout.filter(event => event.ts >= panelOpen.ts && event.ts < panelOpen.ts + 500_000)),
        },
        firstLargeLayout: firstLayout && { relativeMs: click ? (firstLayout.ts - click.ts) / 1000 : null, durationMs: firstLayout.dur / 1000, data: firstLayout.args?.beginData ?? null },
        longest: interesting.sort((a, b) => b.dur - a.dur).slice(0, 25).map(event => ({
            name: event.name, relativeMs: click ? (event.ts - click.ts) / 1000 : null, durationMs: event.dur / 1000,
            data: event.args?.beginData ?? event.args?.data ?? null,
        })),
    }
}
