import { describe, expect, test } from 'bun:test'
import type { Server } from 'socket.io'
import { Store } from '../store'
import { MessageService } from './messageService'
import type { EventPublisher } from './eventPublisher'

describe('persisted response source context', () => {
    test('finds an evicted source by ID and includes bounded context with real position cursors', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('quoted-context', {}, null, 'default')
            const rows = Array.from({ length: 120 }, (_, index) => store.messages.addMessage(session.id, {
                role: 'agent', content: { type: 'text', text: `response ${index}` },
            }, undefined, undefined, 1000))
            const service = new MessageService(store, {} as Server, {} as EventPublisher)
            const target = rows[54]
            const result = service.getMessageContext(session.id, target.id)
            expect(result?.message.id).toBe(target.id)
            expect(result?.position).toEqual({ at: 1000, seq: target.seq })
            expect(result?.page.messages.map(message => message.id)).toEqual(rows.slice(30, 80).map(message => message.id))
            expect(result?.page.page.hasMore).toBe(true)
            expect(result?.page.page.nextBeforeSeq).toBe(rows[30].seq)
            expect(result?.page.page.snapshotHeadSeq).toBe(rows[119].seq)
            expect(result?.epoch).toBe(store.messages.getMessageEpoch(session.id))
        } finally { store.close() }
    })

    test('does not resolve an ID belonging to another session or a deleted source', () => {
        const store = new Store(':memory:')
        try {
            const first = store.sessions.getOrCreateSession('quote-first', {}, null, 'default')
            const other = store.sessions.getOrCreateSession('quote-other', {}, null, 'other')
            const source = store.messages.addMessage(other.id, { role: 'agent', content: { type: 'text', text: 'private' } })
            const service = new MessageService(store, {} as Server, {} as EventPublisher)
            expect(service.getMessageContext(first.id, source.id)).toBeNull()
            expect(service.getMessageContext(first.id, 'missing-source')).toBeNull()
        } finally { store.close() }
    })
})
