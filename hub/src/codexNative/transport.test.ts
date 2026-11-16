import { expect, test } from 'bun:test'
import { NativeConnection } from './transport'

test('closing during connection setup settles callers and prevents reuse', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) })
    const connection = new NativeConnection(`ws://127.0.0.1:${server.port}`)
    try {
        const ready = connection.connect()
        connection.close('Attachment cancelled')
        await expect(ready).rejects.toThrow('Attachment cancelled')
        await expect(connection.connect()).rejects.toThrow('Native connection unavailable')
    } finally {
        connection.close()
        server.stop(true)
    }
})
