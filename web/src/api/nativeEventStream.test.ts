import { afterEach, expect, it, vi } from 'vitest'
import { readNativeEventStream } from './nativeEventStream'

afterEach(() => vi.useRealTimers())

function stream() {
    let writer!: ReadableStreamDefaultController<Uint8Array>
    let signal!: AbortSignal
    const open = async (value: AbortSignal) => {
        signal = value
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                writer = controller
                signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
            },
        }))
    }
    return { open, send: (text: string) => writer.enqueue(new TextEncoder().encode(text)), signal: () => signal }
}

it('keeps a healthy stream alive with heartbeats and reconnects a silent stream', async () => {
    vi.useFakeTimers()
    const source = stream(), event = vi.fn()
    const result = readNativeEventStream(source.open, new AbortController().signal, event).catch(error => error)
    await vi.advanceTimersByTimeAsync(15_000)
    source.send('data: {"method":"hapi/heartbeat"}\r')
    source.send('\n\r\n')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(event).toHaveBeenCalledWith({ method: 'hapi/heartbeat' })
    expect(source.signal().aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toEqual(new Error('Native event stream timed out'))
})

it('reconnects a stale stream on foreground resume without waiting for throttled timers', async () => {
    vi.useFakeTimers()
    const source = stream()
    const result = readNativeEventStream(source.open, new AbortController().signal, vi.fn()).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + 30_000)
    window.dispatchEvent(new Event('pageshow'))
    expect(await result).toEqual(new Error('Native event stream needs to reconnect'))
    expect(vi.getTimerCount()).toBe(0)
})

it('times out a connection that never receives headers', async () => {
    vi.useFakeTimers()
    const result = readNativeEventStream(signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }), new AbortController().signal, vi.fn()).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await result).toEqual(new Error('Native event stream timed out'))
})
