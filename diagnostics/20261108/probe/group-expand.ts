import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installGroupDiagnostics, startLayoutTrace, stopLayoutTrace } from './group-diagnostics'

const directory = path.dirname(fileURLToPath(import.meta.url))
const stage = process.env.HAPI_STAGE ?? '/home/igna/hapi-deployment/native-integrated-stage'
const dist = '/home/igna/hapi-deployment/source/web/dist'
const expectedBundle = '/assets/index-DIlTXYBC.js'
const { Hono } = await import(`${stage}/hub/node_modules/hono/dist/index.js`)
const { chromium } = await import(`${stage}/node_modules/playwright/index.mjs`)
const diagnostics = true
const variant = process.env.HAPI_ABLATION ?? 'baseline'
const supportedVariants = ['baseline', 'grid-width', 'inner-contain', 'reasoning-multiline', 'outer-block', 'reasoning-contain', 'no-max-content', 'tools-only', 'reasoning-heavy', 'tiny-tools', 'system-font', 'repeat-open']
if (!supportedVariants.includes(variant)) throw new Error('Unknown layout ablation: ' + variant)
const output = path.join(directory, variant + (process.env.HAPI_ABLATION_SAMPLE ? '-' + process.env.HAPI_ABLATION_SAMPLE : ''))
await fs.mkdir(output, { recursive: true })

const threadId = 'tool-header-layout-fixture'
const agentId = '01a1b24c-1000-7000-8000-000000000001'
const sessionId = 'codex-native:fixture:' + threadId
const now = Date.now()
const liveTurn = { id: 'fixture-turn', status: 'inProgress' }
const session = {
    id: sessionId, namespace: 'default', seq: 0, createdAt: now - 10_000, updatedAt: now,
    active: true, activeAt: now, metadataVersion: 1, agentStateVersion: 1, thinking: false,
    metadata: { flavor: 'codex', name: 'Review a busy process', host: 'Fixture daemon', path: 'C:\\Fixture', nativeCodex: { endpointId: 'fixture', threadId, available: true } },
}
const detail = { thread: { id: threadId, name: session.metadata.name, status: { type: 'active' } }, threadSettings: {}, activeTurn: liveTurn as typeof liveTurn | null, requests: [] }
const activity = (id: string, kind: string) => ({ id, type: 'subAgentActivity', kind, agentThreadId: agentId, agentPath: '/root/fixture-reviewer', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
const user = (id: string, text: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] })
const command = (id: string, text: string, status = 'completed') => ({ id, type: 'commandExecution', command: text, status, cwd: 'C:\\Fixture', aggregatedOutput: status === 'completed' ? 'fixture output' : null, exitCode: status === 'completed' ? 0 : null, durationMs: status === 'completed' ? 250 : null })
const omitReasoning = variant === 'tools-only' || variant === 'tiny-tools'
const twoTools = variant === 'reasoning-heavy' || variant === 'tiny-tools'
const examples: any[] = [
    user('prompt', 'Review the large running tool group.'),
    activity('agent-start', 'started'),
    ...Array.from({ length: 22 }, (_, index) => {
        const entries = []
        if (!omitReasoning) entries.push({ id: 'reasoning-' + index, type: 'reasoning', summary: ['Review result ' + index + '.' + (variant === 'reasoning-multiline' ? '\n' : ' ') + 'This detail wraps onto another line on a narrow screen so the expanded group exercises real layout.'] })
        if (!twoTools || index === 0) entries.push(command(index === 0 ? 'seed-command' : 'command-' + index, 'git diff -- src/file-' + index + '.ts'))
        return entries
    }).flat(),
    command('running-command', 'git diff --stat', 'inProgress'),
]
const items = examples.map((item, index) => ({ turnId: liveTurn.id, startedAtMs: now - 9000 + 100 * index, completedAtMs: item.type === 'reasoning' || item.status === 'inProgress' ? undefined : now - 8950 + 100 * index, item })).reverse()
const report: any = { recordedAt: new Date().toISOString(), variant, viewport: { width: 390, height: 844 }, fontconfig: process.env.FONTCONFIG_FILE, dist, expectedBundle, requests: [], pageErrors: [], screenshots: [], checks: {} }
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
const subscribers = new Set<ReadableStreamDefaultController>()
const eventBytes = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
function stream(event: unknown, capture = false) {
    let active: ReadableStreamDefaultController
    return new Response(new ReadableStream({
        start(controller) { active = controller; if (capture) subscribers.add(controller); controller.enqueue(eventBytes(event)) },
        cancel() { subscribers.delete(active) },
    }), { headers: { 'Content-Type': 'text/event-stream' } })
}
function broadcast(method: string, params: Record<string, unknown>) {
    for (const subscriber of subscribers) subscriber.enqueue(eventBytes({ method, params: { threadId, turnId: liveTurn.id, ...params } }))
}
app.get('/api/events', () => stream({ type: 'connected', subscriptionId: 'fixture' }))
app.get('/api/codex-native/endpoints/fixture/catalog/events', () => stream({ method: 'hapi/heartbeat', params: {} }))
const base = `/api/codex-native/threads/${threadId}`
app.get(base, c => c.json(detail))
app.get(`${base}/active-turn`, c => c.json({ activeTurn: detail.activeTurn }))
app.get(`${base}/items`, c => c.json({ data: items, nextCursor: null }))
app.get(`${base}/queue`, c => c.json({ data: [], nextCursor: null }))
app.get(`${base}/commands`, c => c.json({ capabilities: {}, planPresets: [], unavailable: {} }))
app.get(`${base}/events`, () => stream({ method: 'hapi/ready', params: detail }, true))
app.all('/api/*', c => { report.requests.push({ method: c.req.method, path: c.req.path }); return c.json({ error: 'Missing isolated fixture' }, 404) })
app.get('*', async c => {
    const filename = path.resolve(dist, '.' + decodeURIComponent(c.req.path))
    if (filename !== dist && !filename.startsWith(`${dist}/`)) return c.text('Invalid path', 400)
    const file = Bun.file(filename)
    return new Response(filename !== dist && await file.exists() ? file : Bun.file(`${dist}/index.html`))
})

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: app.fetch })
const browser = await chromium.launch({ headless: true, executablePath: '/home/igna/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: report.viewport, isMobile: true, hasTouch: true, locale: 'en-US' })
await context.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
const page = await context.newPage()
if (diagnostics) await installGroupDiagnostics(page)
page.setDefaultTimeout(8000)
page.on('pageerror', error => report.pageErrors.push(error.message))
report.bundle = []
report.fontResponses = []
page.on('response', response => {
    const url = new URL(response.url())
    if (/\/assets\/index-[\w-]+\.js$/.test(url.pathname)) report.bundle.push(url.pathname)
    if (/\.(?:woff2?|ttf)$/i.test(url.pathname)) report.fontResponses.push({ path: url.pathname, status: response.status() })
})
const origin = `http://127.0.0.1:${server.port}`
async function capture(name: string) {
    const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    report.screenshots.push({ name, ...geometry })
    await page.screenshot({ path: `${output}/${name}.png` })
}
function check(name: string, condition: boolean) {
    report.checks[name] = condition
    if (!condition) throw Error(name)
}
const group = page.locator('[data-hapi-scroll-anchors*="native:seed-command"]').locator('button[aria-expanded][aria-controls]').first()
const cdp = await context.newCDPSession(page)
function diffMetrics(earlier: Record<string, number>, after: Record<string, number>) {
    return Object.fromEntries(['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map(name => [name, after[name] - earlier[name]]))
}
async function metrics() {
    return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]))
}
try {
    await page.goto(origin + '/sessions/' + encodeURIComponent(sessionId), { waitUntil: 'domcontentloaded' })
    await group.waitFor()
    await page.waitForTimeout(1900)
    check('formalBuildLoaded', report.bundle.includes(expectedBundle) && report.bundle.every((asset: string) => asset === expectedBundle))
    report.cpuThrottle = 4
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: report.cpuThrottle })
    await cdp.send('Performance.enable')
    check('latestRunningGroupStartsCollapsed', await group.getAttribute('aria-expanded') === 'false' && await group.getByLabel('Running').count() === 1)
    const panelId = await group.getAttribute('aria-controls')
    const panel = page.locator('[id="' + panelId + '"]')
    const panelSelector = `[id="${panelId}"]`
    const rules: Record<string, string> = {
        'grid-width': `${panelSelector}{grid-template-columns:minmax(0,1fr);min-width:0}${panelSelector}>.collapsible-inner{min-width:0}`,
        'inner-contain': `${panelSelector}>.collapsible-inner{contain:inline-size}`,
        'outer-block': `${panelSelector}{display:block;transition:none}${panelSelector}:not([data-open]){max-height:0;overflow:hidden}`,
        'reasoning-contain': `${panelSelector} [data-hapi-scroll-anchor^="agent-reasoning:"]>.relative{contain:inline-size}`,
        'no-max-content': `${panelSelector} [data-hapi-scroll-anchor^="agent-reasoning:"] .w-max{width:100%}`,
        'system-font': `${panelSelector},${panelSelector} *{font-family:Arial,sans-serif!important}`,
    }
    if (rules[variant]) await page.addStyleTag({ content: rules[variant] })
    report.cssAblation = rules[variant] ?? null
    const firstRow = panel.locator(omitReasoning ? '[data-hapi-scroll-anchor^="tool:"]' : '[data-hapi-native-reasoning]').first()
    if (variant === 'repeat-open') {
        await group.tap()
        await firstRow.waitFor()
        await page.waitForTimeout(500)
        await group.tap()
        await firstRow.waitFor({ state: 'detached' })
        await page.waitForTimeout(500)
    }
    await page.evaluate(() => {
        const trace: any = { frames: [], longtasks: [], clickAt: null }
        ;(window as any).__expandTrace = trace
        const observer = new PerformanceObserver(list => trace.longtasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration }))))
        observer.observe({ type: 'longtask' })
        document.addEventListener('click', () => { trace.clickAt = performance.now() }, { capture: true, once: true })
        function frame(timestamp: number) {
            trace.frames.push(timestamp)
            if (trace.active !== false) requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
    })
    if (diagnostics) {
        await startLayoutTrace(cdp)
        await page.evaluate(id => (window as any).__groupDiagnostic.start(id), panelId)
    }
    const before = await metrics()
    await group.tap()
    await firstRow.waitFor()
    await page.waitForTimeout(550)
    const expanded = await metrics()
    await page.evaluate(() => { (window as any).__expandTrace.openSampleEnd = performance.now() })
    report.afterOpenText = await group.innerText()
    await page.waitForTimeout(2250)
    const afterTicks = await metrics()
    if (diagnostics) {
        report.domDiagnostics = await page.evaluate(() => (window as any).__groupDiagnostic.stop())
        report.chromeLayoutTrace = await stopLayoutTrace(cdp)
    }
    const cdpFonts = await context.newCDPSession(page)
    await cdpFonts.send('DOM.enable')
    await cdpFonts.send('CSS.enable')
    const { root } = await cdpFonts.send('DOM.getDocument')
    const fontSelector = omitReasoning ? '[data-hapi-scroll-anchor^="tool:"]' : '[data-hapi-native-reasoning] button span'
    const { nodeId } = await cdpFonts.send('DOM.querySelector', { nodeId: root.nodeId, selector: `${panelSelector} ${fontSelector}` })
    report.platformFonts = nodeId ? (await cdpFonts.send('CSS.getPlatformFontsForNode', { nodeId })).fonts : []
    report.computedReasoningFont = await panel.locator(fontSelector).first().evaluate(element => getComputedStyle(element).fontFamily).catch(() => null)
    report.documentFontFaces = await page.evaluate(() => Array.from(document.fonts).reduce((groups: Record<string, Record<string, number>>, face) => {
        const statuses = groups[face.family] ??= {}
        statuses[face.status] = (statuses[face.status] ?? 0) + 1
        return groups
    }, {}))
    await cdpFonts.detach()
    report.afterTicksText = await group.innerText()
    report.dom = { reasoning: await panel.locator('[data-hapi-native-reasoning]').count(), tools: await panel.locator('[data-hapi-scroll-anchor^="tool:"]').count() }
    report.metrics = { click: diffMetrics(before, expanded), steadyExpanded: diffMetrics(expanded, afterTicks) }
    report.trace = await page.evaluate(() => {
        const trace = (window as any).__expandTrace
        trace.active = false
        const ranges = (from: number, to: number) => {
            const frames = trace.frames.filter((at: number) => at >= from && at <= to)
            const gaps = trace.frames.slice(1).flatMap((time: number, i: number) => {
                const before = trace.frames[i]
                return time >= from && before <= to ? [time - before] : []
            })
            const tasks = trace.longtasks.filter((entry: any) => entry.start >= from && entry.start < to)
            return { maxFrameGapMs: Math.max(0, ...gaps), frames: frames.length, longTaskCount: tasks.length, longestTaskMs: Math.max(0, ...tasks.map((task: any) => task.duration)) }
        }
        return { clickAt: trace.clickAt, openSampleEnd: trace.openSampleEnd, open: ranges(trace.clickAt - 20, trace.openSampleEnd), ticks: ranges(trace.openSampleEnd, performance.now()), longtasks: trace.longtasks }
    })
    check('openedExpectedGroup', report.dom.reasoning === (omitReasoning ? 0 : 22) && report.dom.tools === (twoTools ? 2 : 23) && await group.getAttribute('aria-expanded') === 'true')
    check('expandedTimingKeepsTicking', report.afterOpenText !== report.afterTicksText)
    await capture('large-running-group-open')
    report.passed = report.pageErrors.length === 0 && report.requests.length === 0
} catch (error) {
    report.passed = false
    report.failure = String(error)
    report.failureText = await page.locator('body').innerText().catch(() => '')
    report.controls = await page.locator('button[aria-expanded]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, expanded: node.getAttribute('aria-expanded'), controls: node.getAttribute('aria-controls') }))).catch(() => [])
    await capture('failure').catch(() => {})
} finally {
    await browser.close()
    server.stop(true)
    await fs.writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure, requests: report.requests }))
    process.exitCode = report.passed ? 0 : 1
}
