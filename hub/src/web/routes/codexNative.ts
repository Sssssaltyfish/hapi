import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { CODEX_APPROVAL_POLICIES, CODEX_APPROVALS_REVIEWERS } from '@hapi/protocol'
import type { WebAppEnv } from '../middleware/auth'
import { NativeService } from '../../codexNative/service'
import { NativeRegistry, nativeSession } from '../../codexNative/registry'
import { nativeFilePath } from '../../codexNative/files'
import { uploadAttachment, deleteAttachment, attachmentInputs } from '../../codexNative/attachments'
import { record, type NativeRecord } from '../../codexNative/transport'
import { createNativeMachinesRoutes, nativeMachineStatus } from './nativeMachines'
import { createNativeMentionsRoutes } from './nativeMentions'
import { createNativeCreationRoutes } from './nativeCreation'

const limit = (value: string | undefined) =>
    Math.min(100, Math.max(1, Number.parseInt(value ?? '50', 10) || 50))
const settingsSchema = z
    .object({
        model: z.string().min(1).max(200).optional(),
        effort: z.string().min(1).max(100).optional(),
        approvalPolicy: z.enum(CODEX_APPROVAL_POLICIES).optional(),
        approvalsReviewer: z.enum(CODEX_APPROVALS_REVIEWERS).optional(),
    })
    .strict()
const messageSchema = z
    .object({
        text: z.string().default(''),
        attachments: z.array(z.object({ path: z.string() }).passthrough()).optional(),
        clientId: z.string().min(1).max(200),
        expectedTurnId: z.string().min(1).optional(),
    })
    .strict()
    .refine((value) => value.text.length > 0 || Boolean(value.attachments?.length))
const interruptSchema = z.object({ turnId: z.string().min(1).optional() }).strict()
const createThreadSchema = z
    .object({
        cwd: z.string().min(1).max(4096),
        projectId: z.string().min(1).max(200).nullable().optional(),
        model: z.string().min(1).max(200).optional(),
        effort: z.string().min(1).max(100).optional(),
        text: z.string().min(1).max(1_000_000).optional(),
        clientId: z.string().min(1).max(200).optional(),
    })
    .strict()

async function activeNativeTurn(
    native: NativeService,
    threadId: string
): Promise<NativeRecord | null> {
    const metadata = record(await native.readThread(threadId))
    if (record(record(metadata.thread).status).type !== 'active') return null
    const page = record(
        await native.control(threadId, 'thread/turns/list', {
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'notLoaded',
        })
    )
    const turn = record(Array.isArray(page.data) ? page.data[0] : undefined)
    return turn.status === 'inProgress' ? turn : null
}

export function createCodexNativeRoutes(
    source: NativeService | NativeRegistry = new NativeRegistry()
): Hono<WebAppEnv> {
    const registry =
        source instanceof NativeRegistry
            ? source
            : new NativeRegistry(
                  [{ ...source.config, id: 'default', label: 'Codex' }],
                  () => source
              )
    const getEndpoint = (c: Context<WebAppEnv>) => {
        const pathEndpoint = /\/codex-native\/endpoints\/([^/]+)/.exec(c.req.path)?.[1]
        return registry.get(
            c.get('namespace'),
            c.req.param('endpointId') ??
                (pathEndpoint ? decodeURIComponent(pathEndpoint) : c.req.query('endpointId'))
        )
    }
    const getService = (c: Context<WebAppEnv>) => {
        const endpoint = getEndpoint(c)
        if (!endpoint) throw new Error('Native Codex endpoint is not configured for this namespace')
        return endpoint.service
    }
    const app = new Hono<WebAppEnv>()
    app.use('/codex-native/*', async (c, next) => {
        await registry.refresh()
        if (c.req.path.endsWith('/codex-native/status')) return next()
        if (c.req.path.endsWith('/codex-native/endpoints')) return next()
        if (!getEndpoint(c))
            return c.json({ error: 'Native Codex is not configured for this namespace' }, 404)
        return next()
    })
    app.onError((error, c) =>
        c.json(
            { error: error.message },
            /outside the native thread workspace|Symbolic links/.test(error.message)
                ? 403
                : /Invalid file path|File path is too deep/.test(error.message)
                  ? 400
                  : 502
        )
    )
    app.route('/', createNativeMachinesRoutes(registry))
    app.route('/', createNativeMentionsRoutes(registry))
    app.route('/', createNativeCreationRoutes(registry))
    app.post('/codex-native/endpoints/:endpointId/threads', async (c) => {
        const parsed = createThreadSchema.safeParse(await c.req.json())
        if (!parsed.success) return c.json({ error: 'Invalid native thread options' }, 400)
        const { cwd, model, effort, text, clientId, projectId } = parsed.data
        if (!cwd.startsWith('/') && !cwd.startsWith('\\\\') && !/^[A-Za-z]:[\\/]/.test(cwd))
            return c.json({ error: 'Native workspace path must be absolute' }, 400)
        const endpoint = getEndpoint(c)!
        const response = await endpoint.service.startThread(
            {
                cwd,
                ...(model ? { model } : {}),
                ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
                threadSource: 'user',
                projectId: projectId ?? null,
            },
            text ? { text, clientId: clientId ?? crypto.randomUUID() } : undefined
        )
        const thread = record(response.thread)
        return c.json({
            session: nativeSession(endpoint.config, {
                ...thread,
                model: response.model,
                reasoningEffort: response.reasoningEffort,
            }),
            thread,
            ...(response.initialMessageError
                ? { initialMessageError: response.initialMessageError }
                : {}),
        })
    })
    app.get('/codex-native/endpoints/:endpointId/threads/:threadId/file', async (c) => {
        const endpoint = getEndpoint(c)!,
            requested = c.req.query('path') ?? ''
        const { path, metadata } = await nativeFilePath(
            endpoint.service,
            endpoint.config,
            c.req.param('threadId'),
            requested
        )
        if (metadata.isFile !== true)
            return c.json({ success: false, error: 'Path is not a regular file' }, 400)
        const response = record(await endpoint.service.call('fs/readFile', { path }))
        if (typeof response.dataBase64 !== 'string') throw new Error('Invalid native file response')
        const size = Buffer.byteLength(response.dataBase64, 'base64')
        return c.json({
            success: true,
            content: response.dataBase64,
            size,
            modified: metadata.modifiedAtMs,
        })
    })
    app.get('/codex-native/endpoints/:endpointId/threads/:threadId/directory', async (c) => {
        const endpoint = getEndpoint(c)!
        const { path, metadata } = await nativeFilePath(
            endpoint.service,
            endpoint.config,
            c.req.param('threadId'),
            c.req.query('path') ?? '.'
        )
        if (metadata.isDirectory !== true) return c.json({ error: 'Path is not a directory' }, 400)
        const response = record(await endpoint.service.call('fs/readDirectory', { path }))
        const entries = Array.isArray(response.entries) ? response.entries.slice(0, 2000) : []
        return c.json({
            entries,
            truncated: Array.isArray(response.entries) && response.entries.length > entries.length,
        })
    })
    app.get('/codex-native/status', async (c) => {
        if (!getEndpoint(c))
            return c.json({
                enabled: false,
                available: false,
                projects: [],
                membership: 'fallback',
            })
        const desktop = await getService(c).desktop()
        return c.json({
            ...(await nativeMachineStatus(getEndpoint(c)!)),
            projects: desktop.projects,
            membership: desktop.membership,
        })
    })
    app.get('/codex-native/threads', async (c) =>
        c.json(
            await getService(c).catalog({
                cursor: c.req.query('cursor'),
                limit: limit(c.req.query('limit')),
                projectId: c.req.query('projectId'),
                catalog: c.req.query('catalog'),
                parentThreadId: c.req.query('parentThreadId'),
            })
        )
    )
    app.get('/codex-native/models', async (c) =>
        c.json((await getService(c).call('model/list', { limit: 100 })) as NativeRecord)
    )
    app.get('/codex-native/threads/:id', async (c) =>
        c.json((await getService(c).readThread(c.req.param('id'))) as NativeRecord)
    )
    app.get('/codex-native/threads/:id/active-turn', async (c) => {
        return c.json({ activeTurn: await activeNativeTurn(getService(c), c.req.param('id')) })
    })
    app.get('/codex-native/threads/:id/items', async (c) =>
        c.json(
            (await getService(c).items(c.req.param('id'), {
                cursor: c.req.query('cursor'),
                limit: limit(c.req.query('limit')),
                sortDirection: c.req.query('sortDirection') === 'asc' ? 'asc' : 'desc',
            })) as NativeRecord
        )
    )
    app.get('/codex-native/threads/:id/outline', async (c) => {
        let boundaries: unknown
        try { boundaries = c.req.query('stopIds') ? JSON.parse(c.req.query('stopIds')!) : c.req.query('stopId') ? [c.req.query('stopId')] : [] }
        catch { return c.json({ error: 'Invalid outline boundary' }, 400) }
        const parsed = z.array(z.string().max(1000)).max(64).safeParse(boundaries)
        if (!parsed.success) return c.json({ error: 'Invalid outline boundary' }, 400)
        return c.json(await getService(c).outline(c.req.param('id'), c.req.query('cursor') ?? null, parsed.data))
    })
    app.get('/codex-native/threads/:id/queue', async (c) =>
        c.json(await getService(c).control(c.req.param('id'), 'thread/queue/list', {
            limit: limit(c.req.query('limit')), cursor: c.req.query('cursor'),
        }) as NativeRecord)
    )
    app.post('/codex-native/threads/:id/queue/delete', async (c) => {
        const parsed = z.object({ queuedSubmissionId: z.string().min(1).max(500) }).strict().safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid native queue ID' }, 400)
        return c.json(await getService(c).control(c.req.param('id'), 'thread/queue/delete', parsed.data) as NativeRecord)
    })
    app.post('/codex-native/threads/:id/settings', async (c) => {
        const parsed = settingsSchema.safeParse(await c.req.json())
        if (!parsed.success || Object.keys(parsed.data).length === 0)
            return c.json({ error: 'Invalid native settings' }, 400)
        return c.json(await getService(c).settings(c.req.param('id'), parsed.data))
    })
    app.post('/codex-native/threads/:id/attachments', async (c) => {
        const parsed = z
            .object({ filename: z.string().min(1), mimeType: z.string(), dataBase64: z.string() })
            .strict()
            .safeParse(await c.req.json())
        if (!parsed.success) return c.json({ error: 'Invalid native attachment' }, 400)
        const endpoint = getEndpoint(c)!
        return c.json(
            await uploadAttachment(
                endpoint.service,
                endpoint.config,
                c.req.param('id'),
                parsed.data
            )
        )
    })
    app.delete('/codex-native/threads/:id/attachments', async (c) => {
        const parsed = z
            .object({ path: z.string() })
            .strict()
            .safeParse(await c.req.json())
        if (!parsed.success) return c.json({ error: 'Invalid native attachment reference' }, 400)
        const endpoint = getEndpoint(c)!
        return c.json(
            await deleteAttachment(
                endpoint.service,
                endpoint.config,
                c.req.param('id'),
                parsed.data.path
            )
        )
    })
    app.post('/codex-native/threads/:id/messages', async (c) => {
        const parsed = messageSchema.safeParse(await c.req.json())
        if (!parsed.success) return c.json({ error: 'Invalid native message' }, 400)
        const { text, clientId, expectedTurnId } = parsed.data
        const endpoint = getEndpoint(c)!
        const input = text ? await endpoint.service.messageInput(c.req.param('id'), text) : []
        input.push(
            ...(await attachmentInputs(
                endpoint.service,
                endpoint.config,
                c.req.param('id'),
                (parsed.data.attachments ?? []).map((attachment) => attachment.path)
            ))
        )
        if (expectedTurnId)
            return c.json(
                (await getService(c).control(c.req.param('id'), 'turn/steer', {
                    input,
                    clientUserMessageId: clientId,
                    expectedTurnId,
                })) as NativeRecord
            )
        const creatingEmpty = getService(c).isCreatingEmpty(c.req.param('id'))
        const queued = record(
            await getService(c).control(c.req.param('id'), 'thread/queue/add', {
                input,
                clientUserMessageId: clientId,
            })
        )
        if (creatingEmpty) return c.json({ ...queued, accepted: true })
        // Native queue/add automatically schedules ordinary idle input. Explicit start is
        // needed only after interruption; starting an already-dequeued ID races execution.
        try {
            const page = record(
                await getService(c).control(c.req.param('id'), 'thread/turns/list', {
                    limit: 1,
                    sortDirection: 'desc',
                    itemsView: 'notLoaded',
                })
            )
            const latest = record(Array.isArray(page.data) ? page.data[0] : undefined)
            if (latest.status !== 'interrupted') return c.json({ ...queued, accepted: true })
            const [metadata, pending] = await Promise.all([
                getService(c).readThread(c.req.param('id')).then(record),
                getService(c)
                    .control(c.req.param('id'), 'thread/queue/list', { limit: 1 })
                    .then(record),
            ])
            if (
                record(record(metadata.thread).status).type === 'active' ||
                (Array.isArray(pending.data) && pending.data.length === 0)
            ) {
                return c.json({ ...queued, accepted: true })
            }
            let started: unknown
            try {
                started = await getService(c).control(c.req.param('id'), 'thread/queue/start', {})
            } catch (error) {
                // Another client or native auto-draining can consume the queue after
                // our snapshot. Acceptance already succeeded; never replay this input.
                if (error instanceof Error && error.message === 'queue is empty') {
                    return c.json({ ...queued, accepted: true })
                }
                throw error
            }
            return c.json({
                ...queued,
                accepted: true,
                started,
            })
        } catch (error) {
            return c.json({
                ...queued,
                accepted: true,
                startError: error instanceof Error ? error.message : String(error),
            })
        }
    })
    app.post('/codex-native/threads/:id/interrupt', async (c) => {
        const parsed = interruptSchema.safeParse(await c.req.json())
        if (!parsed.success) return c.json({ error: 'Invalid turn ID' }, 400)
        let turnId = parsed.data.turnId
        if (!turnId) {
            const turn = await activeNativeTurn(getService(c), c.req.param('id'))
            if (!turn || typeof turn.id !== 'string')
                return c.json({ error: 'No active native turn' }, 409)
            turnId = turn.id
        }
        return c.json(
            (await getService(c).control(c.req.param('id'), 'turn/interrupt', {
                turnId,
            })) as NativeRecord
        )
    })
    app.post('/codex-native/threads/:id/requests/:requestId', async (c) => {
        const body = record(await c.req.json())
        if (
            'result' in body === 'error' in body ||
            Object.keys(body).some((key) => key !== 'result' && key !== 'error')
        )
            return c.json({ error: 'Provide result or error' }, 400)
        getService(c).reply(c.req.param('id'), c.req.param('requestId'), body)
        return c.json({ sent: true })
    })
    app.get('/codex-native/threads/:id/events', (c) => {
        const encoder = new TextEncoder()
        let release: (() => void) | undefined
        let heartbeat: ReturnType<typeof setInterval> | undefined
        let closed = false
        const cleanup = () => {
            closed = true
            clearInterval(heartbeat)
            release?.()
        }
        const stream = new ReadableStream<Uint8Array>(
            {
                start(controller) {
                    const send = (event: unknown) => {
                        if (closed) return
                        const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                        if (
                            bytes.byteLength > 256 * 1024 ||
                            (controller.desiredSize ?? 0) < bytes.byteLength
                        ) {
                            cleanup()
                            controller.close()
                            return
                        }
                        controller.enqueue(bytes)
                    }
                    c.req.raw.signal.addEventListener(
                        'abort',
                        () => {
                            if (!closed) {
                                cleanup()
                                controller.close()
                            }
                        },
                        { once: true }
                    )
                    heartbeat = setInterval(
                        () => send({ method: 'hapi/heartbeat', params: { timestamp: Date.now() } }),
                        15_000
                    )
                    heartbeat.unref()
                    void getService(c)
                        .subscribe(c.req.param('id'), (event) => {
                            send(event)
                            if (event.method === 'hapi/disconnected' && !closed) {
                                cleanup()
                                controller.close()
                            }
                        })
                        .then(
                            (unsubscribe) => {
                                release = unsubscribe
                                if (closed) unsubscribe()
                            },
                            (error) => {
                                send({
                                    method: 'hapi/disconnected',
                                    params: {
                                        error:
                                            error instanceof Error ? error.message : String(error),
                                    },
                                })
                                if (!closed) {
                                    cleanup()
                                    controller.close()
                                }
                            }
                        )
                },
                cancel: cleanup,
            },
            { highWaterMark: 256 * 1024, size: (value) => value?.byteLength ?? 0 }
        )
        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no',
            },
        })
    })
    return app
}
