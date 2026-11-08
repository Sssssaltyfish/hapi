import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const dependencies = process.env.HAPI_DEPENDENCIES ?? '/home/igna/hapi-deployment/native-integrated-stage'
const dist = process.env.HAPI_DIST ?? '/home/igna/hapi-deployment/source/web/dist'
const { Hono } = await import(`${dependencies}/hub/node_modules/hono/dist/index.js`)
const { chromium } = await import(`${dependencies}/node_modules/playwright/index.mjs`)
const output = path.join(directory, process.env.HAPI_PROBE_OUTPUT ?? 'baseline')
await fs.mkdir(output, { recursive: true })

const threadId = 'fast-history-fixture'
const sessionId = 'codex-native:fixture:' + threadId
const now = Date.now()
const itemCount = Number(process.env.HAPI_ITEM_COUNT ?? 1100)
const networkDelay = Number(process.env.HAPI_DELAY ?? 340)
const [gapStart, gapEnd] = (process.env.HAPI_INVISIBLE_GAP ?? '').split(':').map(Number)
const visibleCount = itemCount - (gapEnd ? Math.max(0, Math.min(gapEnd, itemCount) - Math.max(gapStart, 1) + 1) : 0)
const session = {
    id: sessionId, namespace: 'default', seq: 0, createdAt: now - 60_000, updatedAt: now,
    active: true, activeAt: now, metadataVersion: 1, agentStateVersion: 1, thinking: false,
    metadata: { flavor: 'codex', name: 'Fast history fixture', host: 'Fixture daemon', path: 'C:\\Fixture', nativeCodex: { endpointId: 'fixture', threadId, available: true } },
}
const detail = { thread: { id: threadId, name: session.metadata.name, status: { type: 'idle' } }, threadSettings: {}, activeTurn: null, requests: [] }
function entry(sequence: number) {
    const text = `History item ${sequence}. ` + 'The process logs the selected input and continues. '.repeat(sequence % 23 === 0 ? 3 : 1)
    const item = sequence >= gapStart && sequence <= gapEnd
        ? { id: `row-${sequence}`, type: 'reasoning', summary: [] }
        : sequence % 2 === 0
        ? { id: `row-${sequence}`, type: 'agentMessage', text }
        : { id: `row-${sequence}`, type: 'userMessage', content: [{ type: 'text', text }] }
    return { turnId: `turn-${Math.ceil(sequence / 2)}`, startedAtMs: now - 1_000_000 + sequence * 100, completedAtMs: now - 999_980 + sequence * 100, item }
}
function range(first: number, last: number, descending: boolean) {
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => entry(descending ? last - offset : first + offset))
}
function cursors(first: number, last: number, descending: boolean) {
    const older = first > 1 ? `old:${first}` : null
    const newer = last < itemCount ? `new:${last}` : null
    return { nextCursor: descending ? older : newer, backwardsCursor: descending ? newer : older }
}

const serverRequests: any[] = []
const report: any = { viewport: { width: 390, height: 844 }, dist, fontConfig: process.env.FONTCONFIG_FILE, itemCount, networkDelay, invisibleGap: gapEnd ? [gapStart, gapEnd] : null, unexpected: [], pageErrors: [], bundles: [] }
const app = new Hono()
const expiresAt = Date.now() + 600_000
const token = `fixture.${Buffer.from(JSON.stringify({ uid: 'fixture', ns: 'default', exp: Math.floor(expiresAt / 1000) })).toString('base64url')}.fixture`
app.get('/api/passkey/config', c => c.json({ enabled: true, sharedSession: true }))
app.get('/api/passkey/session', c => c.json({ token, expiresAt, user: { id: 1 } }))
app.get('/health', c => c.json({ status: 'ok', capabilities: {} }))
app.get('/api/sessions', c => c.json({ sessions: [session] }))
app.get('/api/sessions/:id', c => c.json({ session }))
app.get('/api/machines', c => c.json({ machines: [] }))
app.get('/api/app-icon', c => c.json({ revision: null, type: null, canEdit: false }))
app.get('/api/app-icon/image', c => c.redirect('/pwa-64x64.png', 307))
app.get('/api/app-icon/apple-touch', c => c.redirect('/apple-touch-icon-180x180.png', 307))
app.get('/api/voice/transcription/providers', c => c.json({ providers: [] }))
app.post('/api/visibility', c => c.json({ ok: true }))
app.get('/api/hub-settings', c => c.json({ sessionSummaryContract: false, goalBannerVisible: true }))
app.get('/api/voice/backend', c => c.json({ backend: null, backends: [] }))
app.get('/api/codex-native/endpoints', c => c.json({ endpoints: [{ id: 'fixture', displayName: 'Fixture daemon', available: true }] }))
app.get('/api/codex-native/models', c => c.json({ data: [], nextCursor: null }))
function stream(event: unknown) {
    return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) },
    }), { headers: { 'Content-Type': 'text/event-stream' } })
}
app.get('/api/events', () => stream({ type: 'connected', subscriptionId: 'fixture' }))
app.get('/api/codex-native/endpoints/fixture/catalog/events', () => stream({ method: 'hapi/heartbeat', params: {} }))
const base = `/api/codex-native/threads/${threadId}`
app.get(base, c => c.json(detail))
app.get(`${base}/active-turn`, c => c.json({ activeTurn: detail.activeTurn }))
app.get(`${base}/queue`, c => c.json({ data: [], nextCursor: null }))
app.get(`${base}/commands`, c => c.json({ capabilities: {}, planPresets: [], unavailable: {} }))
app.get(`${base}/events`, () => stream({ method: 'hapi/ready', params: detail }))
app.get(`${base}/items`, async c => {
    const cursor = c.req.query('cursor') ?? null
    const descending = c.req.query('sortDirection') !== 'asc'
    const limit = Number(c.req.query('limit') ?? 50)
    const edge = cursor ? Number(cursor.split(':')[1]) : descending ? itemCount + 1 : 0
    if (cursor && (!Number.isInteger(edge) || !cursor.startsWith(descending ? 'old:' : 'new:'))) return c.json({ error: 'Unexpected fixture cursor' }, 400)
    const first = descending ? Math.max(1, edge - limit) : edge + 1
    const last = descending ? edge - 1 : Math.min(itemCount, edge + limit)
    const result = cursors(first, last, descending)
    const request = { route: 'items', cursor, direction: descending ? 'desc' : 'asc', first, last, ...result, hasMore: Boolean(result.nextCursor), start: Date.now(), end: 0 }
    serverRequests.push(request)
    if (cursor) await Bun.sleep(networkDelay)
    request.end = Date.now()
    return c.json({ data: range(first, last, descending), ...result })
})
app.get(`${base}/outline-context`, async c => {
    const itemId = c.req.query('itemId')
    const target = Number(itemId?.replace('row-', ''))
    if (!target || target > itemCount) return c.json({ error: 'Unexpected fixture context target' }, 400)
    const first = Math.max(1, target - 49)
    const last = Math.min(itemCount, target + 50)
    const result = cursors(first, last, true)
    const request = { route: 'context', itemId, first, last, ...result, hasMore: Boolean(result.nextCursor), start: Date.now(), end: 0 }
    serverRequests.push(request)
    await Bun.sleep(networkDelay)
    request.end = Date.now()
    return c.json({ data: range(first, last, true), ...result, newerResumeCursor: `new:${target}` })
})
app.all('/api/*', c => { report.unexpected.push({ method: c.req.method, path: c.req.path }); return c.json({ error: 'Missing isolated fixture' }, 404) })
app.get('*', async c => {
    const filename = path.resolve(dist, '.' + decodeURIComponent(c.req.path))
    if (filename !== dist && !filename.startsWith(`${dist}/`)) return c.text('Invalid path', 400)
    const file = Bun.file(filename)
    return new Response(filename !== dist && await file.exists() ? file : Bun.file(`${dist}/index.html`))
})

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: app.fetch })
const browser = await chromium.launch({ headless: true, executablePath: '/home/igna/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: report.viewport, isMobile: true, hasTouch: true, locale: 'en-US' })
await context.addInitScript(() => {
    localStorage.setItem('hapi-lang', 'en')
    const probe: any = { frames: [], fetches: [], commits: [], active: true }
    const clock = () => Math.round(performance.timeOrigin + performance.now())
    const edge = (row: any) => row && { id: row.id, current: row.current, resident: row.resident, locator: row.locator?.itemId }
    const markCommit = (root: any) => {
        let native: any, panel: any, virtual: any
        function visit(fiber: any) {
            if (!fiber) return
            const props = fiber.memoizedProps
            if (props?.session?.metadata?.nativeCodex?.threadId === 'fast-history-fixture' && props.api && fiber.memoizedState?.next) {
                for (let hook = fiber.memoizedState; hook; hook = hook.next) {
                    const value = hook.memoizedState
                    const items = Array.isArray(value) ? value : value?.items
                    if (!Array.isArray(items) || !/^row-\d+$/.test(items[0]?.item?.id ?? '')) continue
                    let itemsRef = hook.next
                    while (itemsRef && itemsRef.memoizedState?.current !== items) itemsRef = itemsRef.next
                    const cursor = itemsRef?.next
                    if (!cursor) continue
                    native = { first: items[0].item.id, last: items.at(-1).item.id, count: items.length, cursor: cursor.memoizedState, newerCursor: cursor.next.memoizedState, loading: cursor.next.next.next.memoizedState, direction: value.historyDirection }
                    break
                }
            }
            if (props?.onLoadMore && props?.onCancelLoadMore && typeof props.hasMoreMessages === 'boolean') {
                panel = { hasMore: props.hasMoreMessages, hasNewer: props.hasNewerMessages, historyVersion: props.historyVersion }
            }
            if (props?.rows?.length && props?.resolveRowId && props?.viewport) {
                const rows = props.rows
                probe.currentRows = rows
                const first = rows.find((row: any) => row.locator)
                const last = rows.findLast((row: any) => row.locator)
                virtual = { count: rows.length, first: edge(first), last: edge(last) }
            }
            if (!native || !panel || !virtual) {
                visit(fiber.child)
                if (!native || !panel || !virtual) visit(fiber.sibling)
            }
        }
        visit(root.current)
        if (!native || !virtual) return
        const snapshot = { native, panel, virtual }
        const serialized = JSON.stringify(snapshot)
        if (serialized !== probe.lastCommit) {
            probe.lastCommit = serialized
            probe.commits.push({ at: clock(), ...snapshot })
        }
    }
    ;(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_id: number, root: any) => markCommit(root), onCommitFiberUnmount() {},
    }
    function sample() {
        const viewport = document.querySelector<HTMLElement>('[data-hapi-thread-viewport]')
        if (!viewport) return null
        const bounds = viewport.getBoundingClientRect()
        const mounted = Array.from(viewport.querySelectorAll<HTMLElement>('[data-hapi-virtual-row]'))
        const visible = mounted.flatMap(row => {
            const rect = row.getBoundingClientRect()
            return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
                ? [{ id: row.dataset.hapiVirtualRow, y: Math.round((rect.top - bounds.top) * 10) / 10 }] : []
        })
        const loading = Array.from(viewport.parentElement?.querySelectorAll('[role=status]') ?? []).some(node => /^loading/i.test(node.textContent?.trim() ?? ''))
        return { at: clock(), top: Math.round(viewport.scrollTop), height: viewport.scrollHeight, logical: Number(viewport.querySelector('[data-hapi-logical-row-count]')?.getAttribute('data-hapi-logical-row-count') ?? 0), visibleFirst: visible[0]?.id, visibleLast: visible.at(-1)?.id, visible, mountedFirst: mounted[0]?.dataset.hapiVirtualRow, mountedLast: mounted.at(-1)?.dataset.hapiVirtualRow, loading, commit: probe.commits.length - 1 }
    }
    probe.sample = sample
    function frame() {
        if (probe.active) {
            const point = sample()
            if (point) probe.frames.push(point)
            requestAnimationFrame(frame)
        }
    }
    requestAnimationFrame(frame)
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.href, location.href)
        if (!url.pathname.endsWith('/items') && !url.pathname.endsWith('/outline-context')) return originalFetch(input, init)
        const row: any = { route: url.pathname.split('/').at(-1), cursor: url.searchParams.get('cursor'), target: url.searchParams.get('itemId'), direction: url.searchParams.get('sortDirection') ?? 'desc', start: clock(), startFrame: sample() }
        probe.fetches.push(row)
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        signal?.addEventListener('abort', () => { row.abortAt = clock() }, { once: true })
        return originalFetch(input, init).then(response => { row.end = clock(); row.status = response.status; row.endFrame = sample(); return response }, error => {
            row.end = clock()
            row.error = String(error)
            throw error
        })
    }
    ;(window as any).__fastHistoryProbe = probe
})

const page = await context.newPage()
page.setDefaultTimeout(8000)
page.on('pageerror', error => report.pageErrors.push(error.message))
page.on('response', response => { const url = new URL(response.url()); if (/\/assets\/index-[\w-]+\.js$/.test(url.pathname)) report.bundles.push(url.pathname) })
const viewport = page.locator('[data-hapi-thread-viewport]')
const cdp = await context.newCDPSession(page)
const state = () => page.evaluate(() => {
    const probe = (window as any).__fastHistoryProbe
    return { frame: probe.sample(), commit: probe.commits.at(-1) }
})
async function retainedItems() {
    const locators: string[] = await page.evaluate(() => (window as any).__fastHistoryProbe.currentRows.map((row: any) => row.locator?.itemId))
    const known = new Set(locators)
    const expected = Array.from({ length: itemCount }, (_, index) => index + 1)
        .filter(sequence => !(sequence >= gapStart && sequence <= gapEnd)).map(sequence => `row-${sequence}`)
    return { count: known.size, missing: expected.filter(id => !known.has(id)) }
}
function summarize(trace: any) {
    const points = trace.frames
    const intervals: any[] = []
    let pin: any
    for (const point of points) {
        if (point.top <= 1 && point.visibleFirst) {
            if (!pin || point.visibleFirst !== pin.first) {
                if (pin) intervals.push(pin)
                pin = { first: point.visibleFirst, start: point.at, end: point.at, pulses: Number(point.loading), lastLoading: point.loading, frameCount: 1, firstCommit: point.commit, lastCommit: point.commit }
            } else {
                if (point.loading && !pin.lastLoading) pin.pulses++
                pin.end = point.at
                pin.lastLoading = point.loading
                pin.frameCount++
                pin.lastCommit = point.commit
            }
        } else if (pin) {
            intervals.push(pin)
            pin = undefined
        }
    }
    if (pin) intervals.push(pin)
    const counts: Record<string, number> = {}
    for (const request of trace.fetches) {
        const key = `${request.route}:${request.cursor ?? request.target ?? 'latest'}`
        counts[key] = (counts[key] ?? 0) + 1
    }
    const sourceRewinds = trace.commits.flatMap((commit: any, index: number) => {
        const previous = trace.commits[index - 1]
        const first = (row: string) => Number(row.slice(4))
        if (!previous || first(commit.native.first) <= first(previous.native.first)) return []
        return [{ before: previous, after: commit }]
    })
    const timelineShrinks = trace.commits.flatMap((commit: any, index: number) => {
        const previous = trace.commits[index - 1]
        if (!previous || commit.virtual.count >= previous.virtual.count) return []
        return [{ before: previous.virtual, after: commit.virtual, source: commit.native, at: commit.at }]
    })
    const prependAnchors = points.flatMap((point: any, index: number) => {
        const previous = points[index - 1]
        if (!previous?.logical || point.logical <= previous.logical || trace.commits[point.commit]?.native.direction !== 'older') return []
        const anchor = previous.visible.find((row: any) => row.y >= 0 && point.visible.some((next: any) => next.id === row.id))
        const after = anchor && point.visible.find((row: any) => row.id === anchor.id)
        const before = anchor && points[index - 2]?.visible.find((row: any) => row.id === anchor.id)
        return [{ at: point.at, before: previous.logical, after: point.logical, topBefore: previous.top, topAfter: point.top,
            id: anchor?.id, yBefore: anchor?.y, yAfter: after?.y, drift: after?.y - anchor?.y, precedingMotion: anchor?.y - before?.y }]
    })
    return {
        longestPins: intervals.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 10).map(({ lastLoading, ...pin }) => ({ ...pin, ms: pin.end - pin.start })),
        cursorSequence: trace.fetches.map((request: any) => [request.route, request.cursor ?? request.target, request.status, request.error, Boolean(request.abortAt)]),
        repeated: Object.entries(counts).filter(([, count]) => count > 1),
        loadingPulses: points.filter((point: any, index: number) => point.loading && !points[index - 1]?.loading).length,
        maxSourceItems: Math.max(0, ...trace.commits.map((commit: any) => commit.native.count)),
        hasMoreFalse: trace.commits.some((commit: any) => commit.panel?.hasMore === false),
        sourceRewinds,
        timelineShrinks,
        prependAnchors,
    }
}

try {
    await page.goto(`http://127.0.0.1:${server.port}/sessions/${encodeURIComponent(sessionId)}`, { waitUntil: 'domcontentloaded' })
    await page.getByText(new RegExp(`History item ${itemCount}\\.`)).waitFor()
    await page.waitForTimeout(400)
    report.initial = await state()
    const bounds = (await viewport.boundingBox())!
    const x = Math.round(bounds.x + bounds.width / 2)
    const low = Math.round(bounds.y + 35)
    const high = Math.round(bounds.y + bounds.height - 35)
    const sweeps = Number(process.env.HAPI_SWIPES ?? 175)
    const rest = Number(process.env.HAPI_GESTURE_REST ?? 23)
    const touchStep = Number(process.env.HAPI_TOUCH_STEP ?? 8)
    const reverseAt = Number(process.env.HAPI_REVERSE_AT ?? 0)
    const reverseFor = Number(process.env.HAPI_REVERSE_FOR ?? 0)
    const stagnantLimit = Number(process.env.HAPI_STAGNANT_LIMIT ?? 40)
    const checkReverse = process.env.HAPI_CHECK_REVERSE === '1'
    report.touch = { from: low, to: high, sweeps, rest, touchStep, reverseAt, reverseFor, stagnantLimit, checkReverse }
    async function flick(direction: 'older' | 'newer') {
        const [from, to] = direction === 'newer' ? [high, low] : [low, high]
        const start = Date.now()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] })
        for (let step = 1; step <= 3; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * step / 3 }] })
            if (touchStep) await page.waitForTimeout(touchStep)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(rest)
        const current = await state()
        report.gestures ??= []
        report.gestures.push({ start, direction, frame: current.frame })
        return current
    }
    let stagnant = 0
    let previousFirst: string | undefined
    for (let index = 0; index < sweeps; index++) {
        const reverse = reverseAt > 0 && index >= reverseAt && index < reverseAt + reverseFor
        const current = await flick(reverse ? 'newer' : 'older')
        if (current.frame?.top <= 1 && current.frame?.visibleFirst === previousFirst) stagnant++
        else stagnant = 0
        previousFirst = current.frame?.visibleFirst
        if (stagnant >= stagnantLimit && index >= reverseAt + reverseFor) break
        if (stagnant >= 8 && current.commit?.panel?.hasMore === false) break
        if (index % 20 === 19) console.log(JSON.stringify({ gesture: index + 1, ...current }))
    }
    await page.waitForTimeout(2000)
    report.final = await state()
    report.retained = await retainedItems()
    await page.screenshot({ path: `${output}/after-swipes.png` })
    if (checkReverse) {
        for (let index = 0; index < sweeps; index++) {
            const current = await flick('newer')
            if (current.commit?.panel?.hasNewer === false && current.frame?.visibleLast?.endsWith(`:row-${itemCount}`)) break
        }
        await page.waitForTimeout(networkDelay * 2 + 300)
        report.reverseFinal = await state()
        report.reverseRetained = await retainedItems()
        await page.screenshot({ path: `${output}/after-reversal.png` })
    }
} catch (error) {
    report.failure = String(error)
    report.failureText = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
} finally {
    const trace = await page.evaluate(() => {
        const probe = (window as any).__fastHistoryProbe
        if (!probe) return null
        probe.active = false
        return { frames: probe.frames, fetches: probe.fetches, commits: probe.commits }
    }).catch(() => null)
    await browser.close()
    server.stop(true)
    if (trace) {
        report.summary = summarize(trace)
        const preservesAllRows = (snapshot: any, retained: any) => snapshot?.commit?.virtual.count === visibleCount
            && snapshot.commit.virtual.first?.locator === 'row-1'
            && snapshot.commit.virtual.last?.locator === `row-${itemCount}`
            && retained.count === visibleCount && retained.missing.length === 0
        report.checks = {
            exhausted: report.final?.commit?.panel?.hasMore === false && report.final?.frame?.visibleFirst?.endsWith(':row-1') === true,
            reverse: report.reverseFinal?.commit?.panel?.hasNewer === false
                && report.reverseFinal?.frame?.visibleLast?.endsWith(`:row-${itemCount}`) === true
                && report.reverseFinal?.frame?.loading === false
                && !report.summary.repeated.some(([key]: [string, number]) => key.startsWith('outline-context:')),
            noRewind: report.summary.sourceRewinds.length === 0,
            continuity: report.summary.timelineShrinks.length === 0 && preservesAllRows(report.final, report.retained)
                && (!report.touch?.checkReverse || preservesAllRows(report.reverseFinal, report.reverseRetained)),
            loop: report.summary.longestPins.some((pin: any) => pin.ms >= 3000 && pin.pulses >= 3) && report.summary.sourceRewinds.length >= 2 && report.final?.commit?.panel?.hasMore === true,
        }
        await fs.writeFile(`${output}/trace.json`, JSON.stringify(trace))
    }
    report.serverRequests = serverRequests
    await fs.writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ final: report.final, reverseFinal: report.reverseFinal, checks: report.checks, summary: report.summary, failure: report.failure, unexpected: report.unexpected, pageErrors: report.pageErrors }))
    const expected = process.env.HAPI_EXPECT
    if (report.failure || report.pageErrors.length || report.unexpected.length || !report.summary?.maxSourceItems
        || (expected && !report.checks?.[expected]) || (expected === 'exhausted' && !report.touch?.reverseFor && !report.checks?.noRewind)
        || (expected === 'reverse' && !report.checks?.exhausted)
        || (process.env.HAPI_REQUIRE_CONTINUITY === '1' && !report.checks?.continuity)) process.exitCode = 1
}
