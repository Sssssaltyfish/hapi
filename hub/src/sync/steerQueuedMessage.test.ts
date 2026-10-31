import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const io = {
        of: () => ({
            to: () => ({ emit: () => {} })
        })
    }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('SyncEngine.steerQueuedMessage', () => {
    it('rejects every scheduled row, mature ones included, without invoking the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'steer-scheduled',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            // A mature scheduled row: the fire time already passed, but the row
            // is still uninvoked and waiting for the scheduled-FIFO release.
            const message = store.messages.addMessage(
                session.id,
                { text: 'mature scheduled' },
                'mature-local',
                Date.now() - 1_000
            )

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Scheduled messages cannot be steered',
                localId: 'mature-local'
            })
            // The row must stay queued — untouched by the rejected steer.
            const lookup = store.messages.lookupQueuedMessage(session.id, message.id)
            expect(lookup.status).toBe('queued')
        } finally {
            engine.stop()
        }
    })

    it('rejects unsupported flavors without invoking the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'steer-claude',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'hi' }, 'local-id')

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'The active agent adapter has not advertised steering support',
                localId: null
            })
        } finally {
            engine.stop()
        }
    })

    it('returns pending without consuming or dispatching the same reservation twice', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('pending-steer', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude', capabilities: { steering: true }
            }, {}, 'default')
            const message = store.messages.addMessage(session.id, { text: 'long tool boundary' }, 'pending-id')
            let calls = 0
            const rpc = (engine as unknown as { rpcGateway: { steerQueuedMessage: () => Promise<unknown> } }).rpcGateway
            rpc.steerQueuedMessage = async () => {
                calls++
                store.messages.setMessagesDeliveryState(session.id, ['pending-id'], 'dispatching')
                return { steered: false, pending: true }
            }
            expect(await engine.steerQueuedMessage(session.id, message.id)).toEqual({ status: 'pending', localId: 'pending-id' })
            expect(await engine.steerQueuedMessage(session.id, message.id)).toEqual({ status: 'pending', localId: 'pending-id' })
            expect(calls).toBe(1)
            expect(store.messages.getUninvokedLocalMessages(session.id)[0]).toMatchObject({ invokedAt: null, deliveryState: 'dispatching' })
        } finally { engine.stop() }
    })

    it('recovers an abandoned dispatch as unknown after a Hub restart without replaying or consuming it', () => {
        const { store, engine } = createEngine()
        const session = engine.getOrCreateSession('interrupted-steer', { path: '/tmp/project', host: 'localhost', flavor: 'claude' }, {}, 'default')
        store.messages.addMessage(session.id, { text: 'still unconfirmed' }, 'lost-worker')
        store.messages.setMessagesDeliveryState(session.id, ['lost-worker'], 'dispatching')
        engine.stop()
        const restarted = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            expect(store.messages.getUninvokedLocalMessages(session.id)[0]).toMatchObject({ invokedAt: null, deliveryState: 'indeterminate' })
            expect(store.messages.getImmediateQueuedLocalMessages(session.id)).toHaveLength(0)
        } finally { restarted.stop() }
    })
})
