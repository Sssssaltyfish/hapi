import { describe, expect, test } from 'bun:test'
import { NativeCatalogEvents, nativeCatalogEvent } from './catalogEvents'
import type { NativeConnection, NativeEvent } from './transport'

function connection() {
    const listeners = new Set<(event: NativeEvent) => void>()
    let connects = 0, closes = 0
    return {
        listeners,
        connect: async () => { connects++ },
        close: () => { closes++ },
        stats: () => ({ connects, closes }),
        emit: (event: NativeEvent) => { for (const listener of listeners) listener(event) },
    }
}

describe('Native catalog notifications', () => {
    test('shares one initialized connection without attaching threads and releases on last listener', async () => {
        const client = connection()
        const catalog = new NativeCatalogEvents(() => client as unknown as NativeConnection)
        const first: NativeEvent[] = [], second: NativeEvent[] = []
        let delivered: (() => void) | undefined
        const delivery = new Promise<void>(resolve => { delivered = resolve })
        const releaseFirst = await catalog.subscribe(event => first.push(event))
        const releaseSecond = await catalog.subscribe(event => { second.push(event); if (event.method === 'project/changed') delivered!() })
        expect(client.stats()).toEqual({ connects: 1, closes: 0 })
        client.emit({ method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } })
        client.emit({ method: 'item/agentMessage/delta', params: { threadId: 'private', delta: 'not catalog data' } })
        await delivery
        expect(first.map(event => event.method)).toEqual(['hapi/catalogReady', 'project/changed'])
        expect(second.map(event => event.method)).toEqual(first.map(event => event.method))
        expect(first[0]?.params).toEqual({ freshConnection: true })
        expect(second[0]?.params).toEqual({ freshConnection: false })
        releaseFirst(); releaseFirst()
        expect(client.stats().closes).toBe(0)
        releaseSecond()
        expect(client.stats().closes).toBe(1)
    })
    test('preserves source classification and assignment while stripping conversation history', () => {
        expect(nativeCatalogEvent({ method: 'thread/started', params: { thread: {
            id: 'child', projectId: 'p', source: 'subAgent', parentThreadId: 'parent', ephemeral: true,
            cwd: '/repo', name: 'Child', turns: [{ secret: 'history' }], preview: 'message body',
        } } })).toEqual({ method: 'thread/started', params: { thread: {
            id: 'child', projectId: 'p', source: 'subAgent', parentThreadId: 'parent', ephemeral: true,
            cwd: '/repo', name: 'Child',
        } } })
        expect(nativeCatalogEvent({ method: 'thread/project/updated', params: { threadId: 't', projectId: null } }))
            .toEqual({ method: 'thread/project/updated', params: { threadId: 't', projectId: null } })
        expect(nativeCatalogEvent({ method: 'project/changed', params: { projectId: 'p', changeType: 'not-real' } })).toBeNull()
    })
    test('reconnect creates a new connection and disposal closes the active one', async () => {
        const clients = [connection(), connection()]
        let index = 0
        const catalog = new NativeCatalogEvents(() => clients[index++] as unknown as NativeConnection)
        const events: NativeEvent[] = []
        const release = await catalog.subscribe(event => events.push(event))
        clients[0]!.emit({ method: 'hapi/disconnected', params: { error: 'transport details' } })
        expect(events.at(-1)).toEqual({ method: 'hapi/disconnected' })
        await catalog.subscribe(() => {})
        expect(index).toBe(2)
        release()
        catalog.dispose()
        expect(clients[1]!.stats().closes).toBe(1)
    })
    test('observes one native event once across viewers and starts catch-up once without delaying ready', async () => {
        const client = connection(), catalog = new NativeCatalogEvents(() => client as unknown as NativeConnection)
        let observations = 0, catchups = 0, signal: AbortSignal | undefined
        let finish: (() => void) | undefined, observed: (() => void) | undefined
        const pending = new Promise<void>(resolve => { finish = resolve })
        const delivery = new Promise<void>(resolve => { observed = resolve })
        const observer = {
            observe: async () => { observations++ },
            connected: async (value: AbortSignal) => { catchups++; signal = value; await pending },
        }
        const events: NativeEvent[] = []
        const releaseFirst = await catalog.subscribe(event => events.push(event), observer)
        const releaseSecond = await catalog.subscribe(event => { if (event.method === 'project/changed') observed!() }, observer)
        expect(events[0]?.method).toBe('hapi/catalogReady')
        expect(catchups).toBe(1)
        client.emit({ method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } })
        await delivery
        expect(observations).toBe(1)
        releaseFirst()
        expect(signal?.aborted).toBe(false)
        releaseSecond()
        expect(signal?.aborted).toBe(true)
        finish!()
    })
    test('replays a completed pass after ready for late healthy viewers without new reads', async () => {
        const client = connection(), catalog = new NativeCatalogEvents(() => client as unknown as NativeConnection)
        let catchups = 0, complete: (() => void) | undefined
        const finished = new Promise<void>(resolve => { complete = resolve })
        const observer = { connected: async () => { catchups++; return { complete: true } } }
        const first: NativeEvent[] = []
        const releaseFirst = await catalog.subscribe(event => { first.push(event); if (event.method === 'hapi/catalogReconciled') complete!() }, observer)
        await finished
        const late: NativeEvent[] = []
        const releaseLate = await catalog.subscribe(event => late.push(event), observer)
        expect(late).toEqual([
            { method: 'hapi/catalogReady', params: { freshConnection: false } },
            { method: 'hapi/catalogReconciled', params: { complete: true } },
        ])
        expect(first.map(event => event.method)).toEqual(['hapi/catalogReady', 'hapi/catalogReconciled'])
        expect(catchups).toBe(1)
        expect(client.stats().connects).toBe(1)
        releaseFirst(); releaseLate()
    })
    test('delivers completion once after ready when it races with a joining viewer', async () => {
        const client = connection(), catalog = new NativeCatalogEvents(() => client as unknown as NativeConnection)
        let finish: (() => void) | undefined, delivered: (() => void) | undefined
        const pending = new Promise<void>(resolve => { finish = resolve })
        const completed = new Promise<void>(resolve => { delivered = resolve })
        const observer = { connected: async () => { await pending; return { complete: false } } }
        const releaseFirst = await catalog.subscribe(() => {}, observer)
        finish!()
        const events: NativeEvent[] = []
        const releaseJoining = await catalog.subscribe(event => { events.push(event); if (event.method === 'hapi/catalogReconciled') delivered!() }, observer)
        await completed
        expect(events.map(event => event.method)).toEqual(['hapi/catalogReady', 'hapi/catalogReconciled'])
        expect(events[1]?.params).toEqual({ complete: false })
        releaseFirst(); releaseJoining()
    })
})
