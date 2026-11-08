export async function installRunningGroupTrace(page: any, lean = false) {
    await page.addInitScript((lean: boolean) => {
        let active: any = null
        const results: any[] = []
        const inc = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
        function target(node: Node | null) {
            const element = node instanceof Element ? node : node?.parentElement
            if (!element) return 'other'
            if (element.hasAttribute('data-hapi-thread-viewport')) return 'viewport'
            if (element.hasAttribute('data-hapi-virtual-row')) return 'virtual-row'
            const anchor = element.closest('[data-hapi-scroll-anchors]')?.getAttribute('data-hapi-scroll-anchors') ?? ''
            if (anchor.includes('native:completed-seed')) return 'completed-group'
            if (anchor.includes('native:running-seed')) return 'running-group'
            return 'other'
        }
        let rendererId = 0
        if (!lean) (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject() { return ++rendererId },
            onCommitFiberRoot(_id: unknown, root: any) {
                if (!active) return
                const hostTargets: Record<string, number> = {}
                const pending = [root.current]
                while (pending.length) {
                    const fiber = pending.pop()
                    if (!fiber) continue
                    if (fiber.sibling) pending.push(fiber.sibling)
                    if (fiber.child && (fiber.subtreeFlags || !fiber.alternate)) pending.push(fiber.child)
                    if (fiber.stateNode instanceof Element && (fiber.flags || !fiber.alternate)) inc(hostTargets, target(fiber.stateNode))
                }
                active.reactCommits.push({ at: performance.now(), hostTargets })
            },
            onCommitFiberUnmount() {},
        }
        if (!lean) {
        const originalRect = Element.prototype.getBoundingClientRect
        Element.prototype.getBoundingClientRect = function () {
            const phase = active
            const watched = phase && this.hasAttribute('data-hapi-virtual-row')
            const start = watched ? performance.now() : 0
            const result = originalRect.call(this)
            if (watched) { inc(phase.counts, 'virtualRowRect'); phase.times.virtualRowRect += performance.now() - start }
            return result
        }
        const viewportHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!
        Object.defineProperty(Element.prototype, 'scrollHeight', {
            ...viewportHeight,
            get() {
                const phase = active
                if (!phase || !this.hasAttribute('data-hapi-thread-viewport')) return viewportHeight.get!.call(this)
                const start = performance.now()
                const value = viewportHeight.get!.call(this)
                const elapsed = performance.now() - start
                inc(phase.counts, 'viewportScrollHeight')
                phase.times.viewportScrollHeight += elapsed
                return value
            },
        })
        const originalScrollTo = Element.prototype.scrollTo
        Element.prototype.scrollTo = function (...args: [any, any?]) {
            if (active && this.hasAttribute('data-hapi-thread-viewport')) inc(active.counts, 'viewportScrollTo')
            return (originalScrollTo as any).apply(this, args)
        }
        const Observer = window.ResizeObserver
        window.ResizeObserver = class extends Observer {
            constructor(callback) {
                super((entries, observer) => {
                    const phase = active
                    const watched = phase && entries.some(entry => entry.target.hasAttribute('data-hapi-virtual-row'))
                    const start = watched ? performance.now() : 0
                    callback(entries, observer)
                    if (watched) { inc(phase.counts, 'virtualRowObserver'); phase.times.virtualRowObserver += performance.now() - start }
                })
            }
        }
        }
        const longTasks = new PerformanceObserver(list => {
            if (active) active.tasks.push(...list.getEntries().map(entry => ({ at: entry.startTime, duration: entry.duration })))
        })
        longTasks.observe({ type: 'longtask' })
        const mark = (phase: any, point: string) => performance.mark(`hapi-running:${phase.label}:${point}`)
        ;(window as any).__runningGroupTrace = {
            begin(label: string, panelId: string, streamed: boolean) {
                const phase: any = { label, started: performance.now(), frames: [], tasks: [], reactCommits: [], mutationBatches: [], transition: [], counts: {}, times: { virtualRowRect: 0, viewportScrollHeight: 0, virtualRowObserver: 0 } }
                active = phase
                mark(phase, 'start')
                const panel = document.getElementById(panelId)!
                const initialOpen = panel.hasAttribute('data-open')
                const mutation = new MutationObserver(records => {
                    if (!lean) {
                        const changes: Record<string, number> = {}
                        for (const record of records) {
                            inc(changes, `${target(record.target)}:${record.attributeName ?? record.type}`)
                            if (record.attributeName === 'data-hapi-row-size') inc(phase.counts, 'virtualRowSizeAttribute')
                        }
                        phase.mutationBatches.push({ at: performance.now(), changes })
                    }
                    if (!phase.toggle && panel.hasAttribute('data-open') !== initialOpen) {
                        phase.toggle = performance.now()
                        mark(phase, 'toggle')
                    }
                })
                if (lean) mutation.observe(panel, { attributeFilter: ['data-open'] })
                else mutation.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true })
                const onTransition = (event: Event) => {
                    const transition = event as TransitionEvent
                    if (event.target !== panel || transition.propertyName !== 'grid-template-rows') return
                    phase.transition.push({ event: event.type, at: performance.now(), duration: transition.elapsedTime })
                    if (event.type === 'transitionend') mark(phase, 'transition-end')
                }
                for (const type of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) panel.addEventListener(type, onTransition)
                document.addEventListener('click', () => {
                    phase.click = performance.now()
                    phase.clickWall = Date.now()
                    mark(phase, 'click')
                    if (streamed) void (window as any).__startFixtureStream(label)
                }, { capture: true, once: true })
                const frame = (time: number) => {
                    if (active !== phase) return
                    phase.frames.push(time)
                    requestAnimationFrame(frame)
                }
                requestAnimationFrame(frame)
                phase.dispose = () => {
                    mutation.disconnect()
                    for (const type of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) panel.removeEventListener(type, onTransition)
                }
            },
            end() {
                const phase = active
                if (!phase) return
                phase.finished = performance.now()
                mark(phase, 'end')
                phase.dispose()
                delete phase.dispose
                results.push(phase)
                active = null
            },
            results: () => ({ renderers: rendererId, phases: results }),
        }
    }, lean)
}

export function summarizeLeanFrames(phases: any[]) {
    return phases.map(phase => {
        const animationStart = phase.transition.find((row: any) => row.event === 'transitionstart')?.at ?? phase.toggle
        const animationEnd = phase.transition.find((row: any) => row.event === 'transitionend')?.at ?? phase.finished
        const frames = phase.frames.slice(1).map((to: number, index: number) => ({ from: phase.frames[index], to, gap: to - phase.frames[index] }))
        const activeFrames = frames.filter((frame: any) => frame.to >= animationStart && frame.from <= animationEnd)
        return { label: phase.label, clickToToggleMs: phase.toggle - phase.click, animationMs: animationEnd - animationStart,
            maxFrameGapMs: Math.max(0, ...frames.filter((frame: any) => frame.to >= phase.click).map((frame: any) => frame.gap)),
            maxAnimationFrameGapMs: Math.max(0, ...activeFrames.map((frame: any) => frame.gap)),
            slowAnimationFrames: activeFrames.filter((frame: any) => frame.gap > 24).length,
            longestTaskMs: Math.max(0, ...phase.tasks.filter((task: any) => task.at >= phase.click - 2).map((task: any) => task.duration)),
        }
    })
}

export async function readRunningGroupChromeTrace(cdp: any, phases: any[], profile?: any) {
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
    const profileNodes = new Map<number, any>()
    const profileParents = new Map<number, number>()
    const samples: Array<{ id: number, at: number }> = []
    if (profile) {
        for (const node of profile.nodes) {
            profileNodes.set(node.id, node.callFrame)
            for (const child of node.children ?? []) profileParents.set(child, node.id)
        }
        let at = profile.startTime
        for (const [index, id] of profile.samples.entries()) {
            at += profile.timeDeltas[index]
            samples.push({ id, at })
        }
    }
    function summarizeSamples(from: number, to: number) {
        const leaf = new Map<string, number>(), inclusive = new Map<string, number>(), paths = new Map<string, number>()
        const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)
        for (const sample of samples) {
            if (sample.at < from || sample.at >= to) continue
            const seen = new Set<string>(), path = []
            let id: number | undefined = sample.id
            while (id) {
                const frame = profileNodes.get(id)
                if (!frame) break
                const key = `${frame.functionName || '(anonymous)'}@${frame.url.split('/').pop()}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
                if (!path.length) add(leaf, key)
                if (!seen.has(key)) add(inclusive, key)
                seen.add(key)
                path.push(key)
                id = profileParents.get(id)
            }
            if (path.length > 1 && path[0] !== '(idle)@:0:0') add(paths, path.slice(0, 12).join(' ← '))
        }
        const top = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).slice(0, 24)
        return { leaf: top(leaf), inclusive: top(inclusive), paths: top(paths) }
    }
    return phases.map(phase => {
        const mark = (point: string) => events.find(event => event.name === `hapi-running:${phase.label}:${point}`)
        const click = mark('click'), toggle = mark('toggle'), end = mark('end'), transitionEnd = mark('transition-end')
        const animations = phase.transition.filter((row: any) => row.event === 'transitionstart' || row.event === 'transitionend')
        const animationStart = animations.find((row: any) => row.event === 'transitionstart')?.at ?? phase.toggle
        const animationEnd = animations.find((row: any) => row.event === 'transitionend')?.at ?? phase.finished
        const frameGaps = phase.frames.slice(1).map((time: number, index: number) => ({ from: phase.frames[index], to: time, gap: time - phase.frames[index] }))
        const animatedFrames = frameGaps.filter((frame: any) => frame.to >= animationStart && frame.from <= animationEnd)
        const layout = click && end ? events.filter(event => event.name === 'Layout' && event.dur > 0 && event.pid === click.pid && event.tid === click.tid && event.ts >= click.ts && event.ts < end.ts) : []
        const animatedLayouts = toggle ? layout.filter(event => event.ts >= toggle.ts && event.ts <= (transitionEnd?.ts ?? end?.ts)) : []
        const max = (items: number[]) => Math.max(0, ...items)
        const total = (items: any[]) => ({ count: items.length, durationMs: items.reduce((sum, event) => sum + event.dur / 1000, 0), maxMs: max(items.map(event => event.dur / 1000)) })
        return { label: phase.label, clickToToggleMs: phase.toggle - phase.click, animationMs: animationEnd - animationStart,
            maxFrameGapMs: max(frameGaps.filter((frame: any) => frame.to >= phase.click).map((frame: any) => frame.gap)),
            maxAnimationFrameGapMs: max(animatedFrames.map((frame: any) => frame.gap)), slowAnimationFrames: animatedFrames.filter((frame: any) => frame.gap > 24).length,
            longestTaskMs: max(phase.tasks.filter((task: any) => task.at >= phase.click - 2).map((task: any) => task.duration)),
            layouts: total(layout), animationLayouts: total(animatedLayouts),
            profile: profile && click && toggle && end ? {
                beforeToggle: summarizeSamples(click.ts, toggle.ts),
                afterToggle: summarizeSamples(toggle.ts, transitionEnd?.ts ?? end.ts),
                tasks: phase.tasks.filter((task: any) => task.at >= phase.click - 2).map((task: any) => {
                    const from = click.ts + (task.at - phase.click) * 1000
                    return { relativeMs: task.at - phase.click, durationMs: task.duration,
                        ...summarizeSamples(from, from + task.duration * 1000) }
                }),
            } : undefined,
            largestLayouts: [...layout].sort((a, b) => b.dur - a.dur).slice(0, 3).map(event => ({ durationMs: event.dur / 1000, relativeMs: (event.ts - click.ts) / 1000, data: event.args?.beginData })),
        }
    })
}
