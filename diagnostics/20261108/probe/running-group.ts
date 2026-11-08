import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installRunningGroupTrace, readRunningGroupChromeTrace, summarizeLeanFrames } from './running-group-trace'

const directory = path.dirname(fileURLToPath(import.meta.url))
const stage = process.env.HAPI_STAGE ?? '/home/igna/hapi-deployment/native-integrated-stage'
const dist = process.env.HAPI_COMPARE_DIST ?? '/home/igna/hapi-deployment/group-layout-cause-20261108/probe/baseline-dist'
const expectedBundle = process.env.HAPI_COMPARE_BUNDLE ?? '/assets/index-DIlTXYBC.js'
const { Hono } = await import(`${stage}/hub/node_modules/hono/dist/index.js`)
const { chromium } = await import(`${stage}/node_modules/playwright/index.mjs`)
const output = path.join(directory, process.env.HAPI_PROBE_OUTPUT ?? 'running-group-comparison')
await fs.mkdir(output, { recursive: true })
const threadId = 'running-group-comparison-fixture'
const agentId = '01a1b24c-1000-7000-8000-000000000001'
const sessionId = 'codex-native:fixture:' + threadId
const now = Date.now()
const liveTurn = { id: 'turn-running', status: 'inProgress' }
const session = {
    id: sessionId, namespace: 'default', seq: 0, createdAt: now - 10_000, updatedAt: now,
    active: true, activeAt: now, metadataVersion: 1, agentStateVersion: 1, thinking: false,
    metadata: { flavor: 'codex', name: 'Compare two equally sized work groups', host: 'Fixture daemon', path: 'C:\\Fixture', nativeCodex: { endpointId: 'fixture', threadId, available: true } },
}
const detail = { thread: { id: threadId, name: session.metadata.name, status: { type: 'active' } }, threadSettings: {}, activeTurn: liveTurn, requests: [] }
const latestText = 'Final checks:\n\n- Compare the latest result with the original command output.\n- Verify the remaining work stays readable on a narrow screen.'
function createGroup(kind: 'completed' | 'running', baseTime: number) {
    const isRunning = kind === 'running'
    const command = (id: string, command: string, status = 'completed') => ({ id, type: 'commandExecution', command, status, cwd: 'C:\\Fixture', aggregatedOutput: status === 'completed' ? 'fixture output' : null, exitCode: status === 'completed' ? 0 : null, durationMs: status === 'completed' ? 250 : null })
    const rows = [
        { id: kind + '-prompt', type: 'userMessage', content: [{ type: 'text', text: isRunning ? 'Review the current work.' : 'Review the earlier work.' }] },
        { id: kind + '-agent', type: 'subAgentActivity', kind: 'started', agentThreadId: agentId, agentPath: '/root/fixture-reviewer', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
        ...Array.from({ length: 22 }, (_, index) => [
            { id: kind + '-reasoning-' + index, type: 'reasoning', summary: [index === 21 ? latestText : 'Review result ' + index + '. This detail wraps onto another line on a narrow screen so the expanded group exercises real layout.'] },
            command(index === 0 ? kind + '-seed' : kind + '-command-' + index, 'git diff -- src/file-' + index + '.ts'),
        ]).flat(),
        command(kind + '-last-command', 'git diff --stat', isRunning ? 'inProgress' : 'completed'),
        ...(!isRunning ? [{ id: kind + '-answer', type: 'agentMessage', text: 'The earlier work completed.' }] : []),
    ]
    return rows.map((item: any, index) => ({ turnId: 'turn-' + kind, startedAtMs: baseTime + 100 * index,
        completedAtMs: item.status === 'inProgress' || (isRunning && item.id === 'running-reasoning-21') ? undefined : baseTime + 100 * index + 50, item }))
}
const items = [...createGroup('completed', now - 30_000), ...createGroup('running', now - 10_000)].reverse()
const transport: any[] = []
const report: any = { recordedAt: new Date().toISOString(), viewport: { width: 390, height: 844 }, fontconfig: process.env.FONTCONFIG_FILE, dist, expectedBundle, requests: [], pageErrors: [], screenshots: [], checks: {}, trials: [] }
report.summaryOnly = process.env.HAPI_PROBE_SUMMARY_ONLY === '1'
report.lean = process.env.HAPI_PROBE_LEAN === '1'
report.commandItems = process.env.HAPI_PROBE_COMMAND_ITEMS === '1'
report.apiTraffic = []
const app = new Hono()
app.use('/api/*', async (c, next) => {
    report.apiTraffic.push({ at: Date.now(), method: c.req.method, path: c.req.path })
    await next()
})
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
if (process.env.HAPI_PROBE_COLLAPSE_REASONING === '1') {
    report.collapseReasoning = true
    await context.addInitScript(() => localStorage.setItem('hapi-reasoning-collapsed', 'true'))
}
const page = await context.newPage()
await installRunningGroupTrace(page, report.lean)
if (process.env.HAPI_PROBE_REUSE_TIME_FORMAT === '1') {
    report.reuseTimeFormat = true
    await page.addInitScript(() => {
        const compact = { hour: 'numeric', minute: '2-digit', second: '2-digit' } as const
        const full = { year: 'numeric', month: 'short', day: 'numeric', ...compact } as const
        const counts = { compact: 0, full: 0, checked: 0, mismatches: 0 }
        for (const [method, key, expected] of [
            ['toLocaleString', 'full', full], ['toLocaleTimeString', 'compact', compact],
        ] as const) {
            const original = Date.prototype[method]
            const format = new Intl.DateTimeFormat(undefined, expected)
            const entries = Object.entries(expected)
            Date.prototype[method] = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
                if (locales !== undefined || !options || !Number.isFinite(this.getTime()) ||
                    Object.keys(options).length !== entries.length ||
                    !entries.every(([name, value]) => options[name as keyof Intl.DateTimeFormatOptions] === value)) {
                    return original.call(this, locales, options)
                }
                counts[key]++
                const result = format.format(this)
                if (counts[key] <= 4) {
                    counts.checked++
                    if (result !== original.call(this, locales, options)) counts.mismatches++
                }
                return result
            }
        }
        ;(window as any).__fixtureTimeFormat = counts
    })
}
if (process.env.HAPI_PROBE_OMIT_ROW_SIZE === '1') {
    report.omitRowSize = true
    await page.addInitScript(() => {
        const setAttribute = Element.prototype.setAttribute
        Element.prototype.setAttribute = function (name, value) {
            if (name !== 'data-hapi-row-size') setAttribute.call(this, name, value)
        }
    })
}
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
const cdp = await context.newCDPSession(page)
const groupFor = (kind: 'completed' | 'running') => page.locator('[data-hapi-scroll-anchors*="native:' + kind + '-seed"]').locator('button[aria-expanded][aria-controls]').first()
const viewport = page.locator('[data-hapi-thread-viewport]')
const pendingStreams: Promise<void>[] = []
await page.exposeFunction('__startFixtureStream', (label: string) => {
    const work = (async () => {
        const reasoning = items.find(entry => entry.item.id === 'running-reasoning-21')!
        const command = items.find(entry => entry.item.id === 'running-last-command')!
        for (let index = 0; index < 8; index++) {
            if (index) await Bun.sleep(65)
            const delta = ' Stream marker ' + label + ' ' + index + '.'
            reasoning.item.summary[0] += delta
            transport.push({ label, at: Date.now(), method: 'item/reasoning/summaryTextDelta', index, subscribers: subscribers.size })
            broadcast('item/reasoning/summaryTextDelta', { itemId: reasoning.item.id, summaryIndex: 0, delta })
            if (!report.summaryOnly && (index === 0 || index === 7)) {
                transport.push({ label, at: Date.now(), method: 'thread/status/changed', index })
                broadcast('thread/status/changed', { status: { type: 'active' } })
            }
            if (!report.summaryOnly && index % 2 === 0) {
                if (report.commandItems) {
                    const entry = items.find(entry => entry.item.id === 'running-command-20')!
                    const aggregatedOutput = 'Live command output ' + label + ' ' + index
                    entry.item = { ...entry.item, aggregatedOutput }
                    transport.push({ label, at: Date.now(), method: 'item/updated', index, subscribers: subscribers.size })
                    broadcast('item/updated', { item: entry.item, startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs })
                } else {
                    const delta = 'fixture command output ' + index + '\n'
                    command.item.aggregatedOutput = (command.item.aggregatedOutput ?? '') + delta
                    transport.push({ label, at: Date.now(), method: 'item/commandExecution/outputDelta', index })
                    broadcast('item/commandExecution/outputDelta', { itemId: command.item.id, delta })
                }
            }
        }
    })()
    pendingStreams.push(work)
    return work
})
async function phase(kind: 'completed' | 'running', label: string, open: boolean, streamed: boolean) {
    const group = groupFor(kind)
    await group.scrollIntoViewIfNeeded()
    await page.waitForTimeout(90)
    const panelId = (await group.getAttribute('aria-controls'))!
    const panel = page.locator('[id="' + panelId + '"]')
    const before = await viewport.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, distance: element.scrollHeight - element.clientHeight - element.scrollTop }))
    await page.evaluate(({ label, panelId, streamed }) => (window as any).__runningGroupTrace.begin(label, panelId, streamed), { label, panelId, streamed })
    await group.tap()
    await page.waitForFunction(({ id, open }) => document.getElementById(id)?.hasAttribute('data-open') === open, { id: panelId, open })
    if (!open) await panel.locator('[data-hapi-scroll-anchor^="tool:"]').first().waitFor({ state: 'detached' })
    await page.waitForTimeout(streamed ? 620 : 430)
    await page.evaluate(() => (window as any).__runningGroupTrace.end())
    const after = await viewport.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, distance: element.scrollHeight - element.clientHeight - element.scrollTop }))
    const dom = await panel.evaluate(element => ({ tools: element.querySelectorAll('[data-hapi-scroll-anchor^="tool:"]').length,
        reasoning: element.querySelectorAll('[data-hapi-native-reasoning]').length,
        openReasoning: element.querySelectorAll('[data-hapi-native-reasoning] [aria-expanded="true"]').length,
        mountedReasoningMarkdown: element.querySelectorAll('[data-hapi-native-reasoning] .aui-md').length,
        marker: element.textContent?.includes('Stream marker') || !!element.querySelector('[title*="Stream marker"]'),
    }))
    const headerMarker = (await group.textContent())?.includes('Stream marker') ?? false
    report.trials.push({ kind, label, open, streamed, before, after, dom, headerMarker })
    if (open && (dom.tools !== 23 || dom.reasoning !== 22)) throw Error('Unexpected comparable work-group rows: ' + label + ' ' + JSON.stringify(dom))
}
async function cycle(kind: 'completed' | 'running', label: string, streamed = false) {
    await phase(kind, label + '-open', true, streamed)
    await phase(kind, label + '-close', false, streamed)
}
try {
    await page.goto(origin + '/sessions/' + encodeURIComponent(sessionId), { waitUntil: 'domcontentloaded' })
    await groupFor('running').waitFor()
    await page.waitForTimeout(1900)
    await page.evaluate(() => document.fonts.ready)
    check('formalBuildLoaded', report.bundle.includes(expectedBundle) && report.bundle.every((asset: string) => asset === expectedBundle))
    check('completedAndRunningCardsExposeExpectedStates', await groupFor('completed').getByLabel('Running').count() === 0 && await groupFor('running').getByLabel('Running').count() === 1)
    report.cpuThrottle = 4
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: report.cpuThrottle })
    const profileEnabled = process.env.HAPI_PROBE_V8_PROFILE === '1'
    const profileStreamingOnly = profileEnabled && report.lean
    const startProfile = async () => {
        await cdp.send('Profiler.enable')
        await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
        await cdp.send('Profiler.start')
    }
    if (profileEnabled && !profileStreamingOnly) await startProfile()
    if (!report.lean) await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.stack', transferMode: 'ReturnAsStream' })
    await cycle('completed', 'first-completed')
    await cycle('running', 'first-running')
    await cycle('completed', 'warm-completed-1')
    await cycle('running', 'quiet-running-1')
    if (!report.commandItems) {
        await cycle('completed', 'warm-completed-2')
        await cycle('running', 'quiet-running-2')
    }
    if (profileStreamingOnly) {
        await startProfile()
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' })
    }
    await cycle('running', 'streaming-running', true)
    await Promise.all(pendingStreams)
    const trace = await page.evaluate(() => (window as any).__runningGroupTrace.results())
    report.runtime = trace
    const profile = profileEnabled ? (await cdp.send('Profiler.stop')).profile : undefined
    report.chrome = report.lean ? summarizeLeanFrames(trace.phases) : await readRunningGroupChromeTrace(cdp, trace.phases, profile)
    if (profileStreamingOnly) {
        await fs.writeFile(`${output}/streaming-profile.json`, JSON.stringify(profile))
        report.profiledPhases = await readRunningGroupChromeTrace(cdp, trace.phases.filter((phase: any) => phase.label.startsWith('streaming-')), profile)
    }
    report.transport = transport
    let markerWasRendered = report.trials.some((trial: any) => trial.streamed && (trial.dom.marker || trial.headerMarker))
    if (!markerWasRendered && report.collapseReasoning) {
        const group = groupFor('running')
        await group.tap()
        const panelId = await group.getAttribute('aria-controls')
        const lastReasoning = page.locator(`[id="${panelId}"] [data-hapi-native-reasoning="disclosure"] button`).last()
        await lastReasoning.tap()
        const lastReasoningPanelId = await lastReasoning.getAttribute('aria-controls')
        const marker = page.locator(`[id="${lastReasoningPanelId}"]`).getByText(/Stream marker streaming-running-close 7/)
        await marker.waitFor()
        markerWasRendered = true
    }
    check('actualStreamingUpdatesReachedCard', markerWasRendered && transport.some(event => event.subscribers > 0))
    check('allOpenAndClosePhasesWereObserved', report.chrome.length === (report.commandItems ? 10 : 14) && report.chrome.every((phase: any) => phase.animationMs > 0))
    if (report.commandItems) {
        const group = groupFor('running')
        await group.tap()
        const panelId = await group.getAttribute('aria-controls')
        await page.locator(`[id="${panelId}"] button[data-hapi-scroll-anchor*="running-command-20"]`).tap()
        const marker = page.getByRole('dialog').getByText(/Live command output streaming-running-close 6/)
        await marker.waitFor()
        check('liveCommandItemReachedToolDialog', true)
    }
    if (report.reuseTimeFormat) {
        report.timeFormat = await page.evaluate(() => (window as any).__fixtureTimeFormat)
        check('reusedFormattersProduceIdenticalText', report.timeFormat.checked === 8 && report.timeFormat.mismatches === 0)
    }
    await capture('warmed-comparison-after-close')
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
