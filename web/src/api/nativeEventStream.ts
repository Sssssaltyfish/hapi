import type { NativeEvent } from '@/codex-native/types'

/** Native streams have a 15s Hub heartbeat, including while a daemon attaches. */
export async function readNativeEventStream(
    open: (signal: AbortSignal) => Promise<Response>,
    signal: AbortSignal,
    onEvent: (event: NativeEvent) => void,
): Promise<void> {
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    let lastActivity = Date.now()
    let timer: ReturnType<typeof setTimeout>
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const resetDeadline = (delay: number) => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(new Error('Native event stream timed out')), delay)
    }
    const resume = () => {
        if (document.visibilityState === 'visible' && Date.now() - lastActivity > 20_000)
            controller.abort(new Error('Native event stream needs to reconnect'))
    }
    const online = () => controller.abort(new Error('Network restored; reconnecting native stream'))
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('pageshow', resume)
    window.addEventListener('online', online)
    resetDeadline(20_000)
    try {
        const response = await open(combined)
        if (!response.body) throw new Error('Native event stream unavailable')
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!combined.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            lastActivity = Date.now()
            resetDeadline(45_000)
            buffer += decoder.decode(value, { stream: true })
            // Normalize after joining chunks: CR and LF can arrive separately.
            buffer = buffer.replace(/\r\n/g, '\n')
            let boundary: number
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
                if (data) onEvent(JSON.parse(data) as NativeEvent)
            }
        }
        combined.throwIfAborted()
    } finally {
        clearTimeout(timer!)
        document.removeEventListener('visibilitychange', resume)
        window.removeEventListener('pageshow', resume)
        window.removeEventListener('online', online)
        controller.abort()
        // Do not hold reconnection behind a stalled stream's cancellation.
        if (reader) void reader.cancel().catch(() => {}).finally(() => reader?.releaseLock())
    }
}
