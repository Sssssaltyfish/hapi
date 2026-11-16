import { expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
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

async function pendingQuestion() {
    let socket!: ServerWebSocket<undefined>
    let received!: (value: unknown) => void
    const answer = new Promise<unknown>(resolve => { received = resolve })
    const server = Bun.serve<undefined>({
        hostname: '127.0.0.1', port: 0,
        fetch(request, server) {
            if (server.upgrade(request, { data: undefined })) return
            return new Response('WebSocket required', { status: 400 })
        },
        websocket: {
            open(value) { socket = value },
            message(socket, data) {
                const message = JSON.parse(String(data))
                if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }))
                else if (message.method === 'initialized') socket.send(JSON.stringify({
                    id: 42, method: 'item/tool/requestUserInput', params: { threadId: 'thread', questions: [] },
                }))
                else received(message)
            },
        },
    })
    const connection = new NativeConnection(`ws://127.0.0.1:${server.port}`)
    const question = new Promise<void>(resolve => {
        connection.listeners.add(event => { if (event.method === 'hapi/request') resolve() })
    })
    await connection.connect()
    await question
    return {
        connection, answer,
        resolved: (id: string | number) => socket.send(JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: id, threadId: 'thread' } })),
        dispose() { connection.close(); server.stop(true) },
    }
}

test('a socket write is not success until the daemon resolves the matching question', async () => {
    const fixture = await pendingQuestion()
    try {
        let settled = false
        const reply = fixture.connection.reply('42', 'thread', { result: { answers: {} } }).then(() => { settled = true })
        expect(await fixture.answer).toEqual({ id: 42, result: { answers: {} } })
        expect(settled).toBe(false)
        await expect(fixture.connection.reply('42', 'thread', { result: {} })).rejects.toThrow('awaiting confirmation')
        const unrelated = new Promise<void>(resolve => {
            fixture.connection.listeners.add(event => {
                if (event.method === 'hapi/requestResolved' && (event.params as { id: number }).id === 43) resolve()
            })
        })
        fixture.resolved(43)
        await unrelated
        expect(settled).toBe(false)
        fixture.resolved('42')
        await reply
        expect(settled).toBe(true)
        expect(fixture.connection.requests.size).toBe(0)
    } finally { fixture.dispose() }
})

test('disconnecting before confirmation fails the reply instead of reporting success', async () => {
    const fixture = await pendingQuestion()
    try {
        const reply = fixture.connection.reply('42', 'thread', { result: { answers: {} } })
        const outcome = reply.catch(error => error)
        await fixture.answer
        fixture.connection.close('Lost daemon connection')
        expect(await outcome).toEqual(new Error('Lost daemon connection'))
    } finally { fixture.dispose() }
})

test('a question already resolved by the daemon closes quietly without another socket reply', async () => {
    const fixture = await pendingQuestion()
    try {
        const resolved = new Promise<void>(resolve => {
            fixture.connection.listeners.add(event => { if (event.method === 'hapi/requestResolved') resolve() })
        })
        fixture.resolved('42')
        await resolved
        expect(await fixture.connection.reply('42', 'thread', { result: { answers: {} } }))
            .toEqual({ resolved: true, alreadyResolved: true })
        await expect(fixture.connection.reply('42', 'other-thread', { result: {} })).rejects.toThrow('no longer pending')
    } finally { fixture.dispose() }
})
