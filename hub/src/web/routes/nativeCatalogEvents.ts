import type { Context } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import type { NativeService } from '../../codexNative/service'
import type { NativeEvent } from '../../codexNative/transport'

export function nativeCatalogEventResponse(
    c: Context<WebAppEnv>,
    service: NativeService,
    observe: (event: NativeEvent) => Promise<void>,
    subscribeLocal: (listener: (event: NativeEvent) => void) => () => void,
    connected?: (signal: AbortSignal) => Promise<unknown>,
): Response {
    const encoder = new TextEncoder()
    let release: (() => void) | undefined
    let releaseLocal: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let closed = false
    const cleanup = () => {
        closed = true
        clearInterval(heartbeat)
        release?.()
        releaseLocal?.()
    }
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const close = () => {
                if (closed) return
                cleanup()
                controller.close()
            }
            const send = (event: unknown) => {
                if (closed) return
                const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                if (bytes.byteLength > 256 * 1024 || (controller.desiredSize ?? 0) < bytes.byteLength) {
                    close()
                    return
                }
                controller.enqueue(bytes)
            }
            if (c.req.raw.signal.aborted) return close()
            c.req.raw.signal.addEventListener('abort', close, { once: true })
            releaseLocal = subscribeLocal(send)
            heartbeat = setInterval(() => send({ method: 'hapi/heartbeat', params: { timestamp: Date.now() } }), 15_000)
            heartbeat.unref()
            void service.subscribeCatalog(event => {
                if (closed) return
                send(event)
                if (event.method === 'hapi/disconnected') close()
            }, { observe, connected }).then(unsubscribe => {
                release = unsubscribe
                if (closed) unsubscribe()
            }, () => {
                send({ method: 'hapi/disconnected' })
                close()
            })
        },
        cancel: cleanup,
    }, { highWaterMark: 256 * 1024, size: value => value?.byteLength ?? 0 })
    return new Response(stream, { headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
    } })
}
