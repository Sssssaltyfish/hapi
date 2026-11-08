import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { MEDIA_CHUNK_BYTES, type MediaSource } from '@hapi/protocol/apiTypes'
import type { MediaConfig } from '../../config/media'
import { nativeFilePath } from '../../codexNative/files'
import { parseNativeSessionId, type NativeRegistry } from '../../codexNative/registry'
import { NATIVE_PAYLOAD_LIMIT_ERROR, record } from '../../codexNative/transport'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { ifNoneMatchMatches } from '../etag'
import { NativeMediaCache, NativeMediaCacheError } from '../nativeMediaCache'
import { requireSession, requireSyncEngine } from './guards'

const mediaMimeType = z.string().regex(/^(?:audio|video|image)\/[a-z0-9][a-z0-9.+_-]{0,63}$/)
const ticketRequest = z.union([
    z.object({ sessionId: z.string().min(1).max(512), path: z.string().min(1).max(4096), mimeType: mediaMimeType }).strict(),
    z.object({ sessionId: z.string().min(1).max(512), generatedImageId: z.string().min(1).max(512) }).strict()
])

type NativeBinding = NonNullable<ReturnType<NativeRegistry['alias']>>
type MediaTarget = {
    namespace: string
    sessionId: string
    mimeType: string
} & (
    | { kind: 'runner'; source: MediaSource; version: string; size: number }
    | { kind: 'native'; binding: NativeBinding; requested: string; path: string; version: string }
)
type MediaTicket = MediaTarget & { expiresAt: number; etag: string; nativeCacheKey?: string }

type ByteSource = {
    size: number
    read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>
    release?: () => void
}

function byteRange(value: string, size: number): { start: number; end: number } | undefined {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
    if (!match || !size || (!match[1] && !match[2])) return undefined
    if (!match[1]) {
        const suffix = Number(match[2])
        if (!suffix) return undefined
        return { start: Math.max(0, size - suffix), end: size - 1 }
    }
    const start = Number(match[1])
    const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
    if (start >= size || start > end) return undefined
    return { start, end }
}

function streamBytes(source: ByteSource, start: number, end: number, signal: AbortSignal) {
    let offset = start
    let finished = false
    let abort: () => void
    const finish = () => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', abort)
        source.release?.()
    }
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            abort = () => {
                finish()
                controller.error(signal.reason)
            }
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
        },
        async pull(controller) {
            try {
                const length = Math.min(MEDIA_CHUNK_BYTES, end - offset + 1)
                const bytes = await source.read(offset, length)
                if (finished) return
                if (bytes.byteLength !== length) throw new Error('Incomplete media response')
                controller.enqueue(bytes)
                offset += length
                if (offset > end) {
                    finish()
                    controller.close()
                }
            } catch (error) {
                if (finished) return
                finish()
                controller.error(error)
            }
        },
        cancel: finish
    }, { highWaterMark: 0 })
}

function nativeVersion(metadata: Record<string, unknown>): string {
    if (!Number.isSafeInteger(metadata.createdAtMs) || !Number.isSafeInteger(metadata.modifiedAtMs)) {
        throw new Error('Native media has no file version')
    }
    return `${metadata.createdAtMs}:${metadata.modifiedAtMs}`
}

function sameNativeBinding(a: NativeBinding, b: NativeBinding): boolean {
    return a.threadId === b.threadId && a.endpoint.service === b.endpoint.service &&
        a.endpoint.config.fileAccess === b.endpoint.config.fileAccess &&
        JSON.stringify(a.endpoint.config.allowedRoots) === JSON.stringify(b.endpoint.config.allowedRoots)
}

export function createMediaRoutes(getEngine: () => SyncEngine | null, registry: NativeRegistry, config: MediaConfig, secret: Uint8Array) {
    const publicRoutes = new Hono<WebAppEnv>()
    const authenticatedRoutes = new Hono<WebAppEnv>()
    const tickets = new Map<string, MediaTicket>()
    const nativeCache = new NativeMediaCache(config)
    // The extra space covers the JSON-RPC envelope and initialize response on
    // this dedicated connection.
    const nativeMaxPayload = Math.min(Number.MAX_SAFE_INTEGER, 4 * Math.ceil(config.nativeCacheMaxBytes / 3) + 64 * 1024)
    const digest = (purpose: string, data: unknown) => createHmac('sha256', secret)
        .update(`hapi-media-${purpose}-v1\0`)
        .update(JSON.stringify(data))
        .digest('base64url')

    function issue(ticket: MediaTarget) {
        let nativeCacheKey: string | undefined
        let representation: unknown
        if (ticket.kind === 'native') {
            const { config } = ticket.binding.endpoint
            nativeCacheKey = digest('snapshot', [ticket.namespace, config.id, config.endpoint, config.token,
                config.fileAccess, config.allowedRoots, ticket.binding.threadId, ticket.path, ticket.version])
            representation = ['native', nativeCacheKey, ticket.mimeType]
        } else {
            representation = ['runner', ticket.namespace, ticket.sessionId, ticket.source, ticket.version, ticket.size, ticket.mimeType]
        }
        const key = digest('ticket', representation)
        const now = Date.now()
        // Reissuing the same representation renews the existing URL. Insertion
        // order still corresponds to expiry order when pruning the ticket table.
        tickets.delete(key)
        for (const [oldKey, value] of tickets) {
            if (value.expiresAt > now && tickets.size < config.maxTickets) break
            tickets.delete(oldKey)
        }
        const expiresAt = now + config.ticketTtlSeconds * 1000
        tickets.set(key, { ...ticket, expiresAt, nativeCacheKey, etag: `"${digest('etag', representation)}"` })
        return { ticket: key, expiresAt }
    }

    authenticatedRoutes.post('/media/tickets', async (c) => {
        c.header('Cache-Control', 'no-store')
        const parsed = ticketRequest.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid media request' }, 400)
        const input = parsed.data
        const namespace = c.get('namespace')
        const engine = getEngine()
        const identity = parseNativeSessionId(input.sessionId)
        const access = identity ? undefined : engine?.resolveSessionAccess(input.sessionId, namespace)
        try {
            await registry.refresh()
            const endpoint = identity && registry.get(namespace, identity.endpointId)
            const binding = identity && endpoint ? { endpoint, threadId: identity.threadId }
                : access?.ok ? registry.alias(access.session, namespace) : undefined
            if (binding) {
                if (!('path' in input)) return c.json({ error: 'Generated media not found' }, 404)
                const { path, metadata } = await nativeFilePath(binding.endpoint.service, binding.endpoint.config, binding.threadId, input.path)
                if (metadata.isFile !== true) return c.json({ error: 'Path is not a regular file' }, 400)
                return c.json(issue({
                    kind: 'native', namespace, sessionId: input.sessionId, mimeType: input.mimeType,
                    binding, requested: input.path, path, version: nativeVersion(metadata)
                }))
            }
            if (identity || (access?.ok && access.session.metadata?.nativeCodex)) {
                return c.json({ error: 'Native session not found' }, 404)
            }
            const connected = requireSyncEngine(c, getEngine)
            if (connected instanceof Response) return connected
            const session = requireSession(c, connected, input.sessionId)
            if (session instanceof Response) return session
            const source: MediaSource = 'path' in input ? { path: input.path } : { generatedImageId: input.generatedImageId }
            const media = await connected.readMedia(session.sessionId, source)
            if (!media.success || !Number.isSafeInteger(media.size) || media.size < 0 || typeof media.version !== 'string') {
                return c.json({ error: 'Media file unavailable' }, 404)
            }
            const mimeType = mediaMimeType.safeParse('mimeType' in input ? input.mimeType : media.mimeType)
            if (!mimeType.success) return c.json({ error: 'Unsupported media type' }, 415)
            return c.json(issue({
                kind: 'runner', namespace, sessionId: session.sessionId, mimeType: mimeType.data,
                source, size: media.size, version: media.version
            }))
        } catch (error) {
            if (error instanceof Error && /outside the native thread workspace|Symbolic links/.test(error.message)) {
                return c.json({ error: error.message }, 403)
            }
            return c.json({ error: 'Media file unavailable' }, 502)
        }
    })

    publicRoutes.get('/media/:ticket', async (c) => {
        const key = c.req.param('ticket')
        const ticket = tickets.get(key)
        c.header('Cache-Control', 'private, no-store')
        c.header('Referrer-Policy', 'no-referrer')
        if (!ticket || ticket.expiresAt <= Date.now()) {
            tickets.delete(key)
            return c.json({ error: 'Media ticket not found or expired' }, 404)
        }

        const browserCacheControl = () => {
            const remaining = Math.max(0, Math.floor((ticket.expiresAt - Date.now()) / 1000))
            return `private, max-age=${Math.min(config.browserMaxAgeSeconds, remaining)}, must-revalidate`
        }
        const notModified = ifNoneMatchMatches(c.req.header('If-None-Match'), ticket.etag)
        const conditionalResponse = () => c.body(null, 304, { 'Cache-Control': browserCacheControl(), ETag: ticket.etag })
        const expired = () => c.json({ error: 'Media ticket not found or expired' }, 404)
        let source: ByteSource
        try {
            const engine = getEngine()
            if (ticket.kind === 'runner') {
                if (!engine?.resolveSessionAccess(ticket.sessionId, ticket.namespace).ok) return c.notFound()
                const media = await engine.readMedia(ticket.sessionId, ticket.source)
                if (!media.success || media.version !== ticket.version || media.size !== ticket.size) {
                    return c.json({ error: 'Media file changed or is unavailable' }, 409)
                }
                if (ticket.expiresAt <= Date.now()) return expired()
                if (notModified) return conditionalResponse()
                source = {
                    size: ticket.size,
                    async read(offset, length) {
                        const response = await engine.readMedia(ticket.sessionId, {
                            ...ticket.source, range: { offset, length, version: ticket.version }
                        })
                        if (!response.success || response.version !== ticket.version || response.size !== ticket.size ||
                            typeof response.content !== 'string' || response.content.length !== 4 * Math.ceil(length / 3)) {
                            throw new Error('Media file unavailable')
                        }
                        return Buffer.from(response.content, 'base64')
                    }
                }
            } else {
                await registry.refresh()
                const identity = parseNativeSessionId(ticket.sessionId)
                const endpoint = identity && registry.get(ticket.namespace, identity.endpointId)
                const access = identity ? undefined : engine?.resolveSessionAccess(ticket.sessionId, ticket.namespace)
                const binding = identity && endpoint ? { endpoint, threadId: identity.threadId }
                    : access?.ok ? registry.alias(access.session, ticket.namespace) : undefined
                if (!binding || !sameNativeBinding(ticket.binding, binding)) return c.notFound()
                const { service, config: endpointConfig } = binding.endpoint
                const { path, metadata } = await nativeFilePath(service, endpointConfig, binding.threadId, ticket.requested)
                if (path !== ticket.path || metadata.isFile !== true || nativeVersion(metadata) !== ticket.version) {
                    return c.json({ error: 'Media file changed or is unavailable' }, 409)
                }
                if (ticket.expiresAt <= Date.now()) return expired()
                if (notModified) return conditionalResponse()
                source = await nativeCache.acquire(ticket.nativeCacheKey!, async () => {
                    if (ticket.expiresAt <= Date.now()) throw new Error('Media ticket expired')
                    const response = record(await service.call('fs/readFile', { path }, undefined, nativeMaxPayload))
                    const current = record(await service.call('fs/getMetadata', { path }))
                    if (typeof response.dataBase64 !== 'string' || current.isFile !== true ||
                        (endpointConfig.fileAccess !== 'host' && current.isSymlink === true) || nativeVersion(current) !== ticket.version) {
                        throw new Error('Media file unavailable')
                    }
                    return response.dataBase64
                })
            }
        } catch (error) {
            if (ticket.expiresAt <= Date.now()) return expired()
            if (error instanceof NativeMediaCacheError) return c.json({ error: error.message }, error.status)
            if (error instanceof Error && (error.message === NATIVE_PAYLOAD_LIMIT_ERROR ||
                (error as NodeJS.ErrnoException).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH')) {
                return c.json({ error: 'Media exceeds the native cache capacity' }, 413)
            }
            return c.json({ error: 'Media file unavailable' }, 502)
        }
        if (ticket.expiresAt <= Date.now()) {
            source.release?.()
            return expired()
        }

        const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Type': ticket.mimeType,
            'Content-Disposition': 'inline',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            ETag: ticket.etag,
        }
        const head = c.req.raw.method === 'HEAD'
        const ifRange = c.req.header('If-Range')
        const value = !head && (ifRange === undefined || ifRange.trim() === ticket.etag) ? c.req.header('Range') : undefined
        const range = value === undefined ? undefined : byteRange(value, source.size)
        if (value !== undefined && !range) {
            source.release?.()
            return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${source.size}` })
        }
        c.header('Cache-Control', browserCacheControl())
        if (head || !source.size) {
            source.release?.()
            return c.body(null, 200, { ...headers, 'Content-Length': String(source.size) })
        }
        const start = range?.start ?? 0
        const end = range?.end ?? source.size - 1
        return c.body(streamBytes(source, start, end, c.req.raw.signal), range ? 206 : 200, {
            ...headers,
            'Content-Length': String(end - start + 1),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${source.size}` } : {})
        })
    })

    return { publicRoutes, authenticatedRoutes }
}
