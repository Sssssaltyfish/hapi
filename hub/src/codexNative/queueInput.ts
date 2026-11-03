import type { NativeService } from './service'
import { record, type NativeRecord } from './transport'

/** The daemon owns queued input; a later start failure must not undo acceptance. */
export async function queueNativeInput(
    native: NativeService,
    threadId: string,
    input: NativeRecord[],
    clientId: string
): Promise<NativeRecord & { accepted: true }> {
    const creatingEmpty = native.isCreatingEmpty(threadId)
    const queued = record(await native.control(threadId, 'thread/queue/add', {
        input,
        clientUserMessageId: clientId
    }))
    const queuedId = record(queued.queuedSubmission).id
    if (typeof queuedId !== 'string' || !queuedId) {
        throw new Error('Native input acceptance could not be confirmed')
    }
    if (creatingEmpty) return { ...queued, accepted: true }
    try {
        const page = record(await native.control(threadId, 'thread/turns/list', {
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'notLoaded'
        }))
        const latest = record(Array.isArray(page.data) ? page.data[0] : undefined)
        if (latest.status !== 'interrupted') return { ...queued, accepted: true }
        const [metadata, pending] = await Promise.all([
            native.readThread(threadId).then(record),
            native.control(threadId, 'thread/queue/list', { limit: 1 }).then(record)
        ])
        if (record(record(metadata.thread).status).type === 'active'
            || (Array.isArray(pending.data) && pending.data.length === 0)) {
            return { ...queued, accepted: true }
        }
        let started: unknown
        try {
            started = await native.control(threadId, 'thread/queue/start', {})
        } catch (error) {
            if (error instanceof Error && error.message === 'queue is empty') {
                return { ...queued, accepted: true }
            }
            throw error
        }
        return { ...queued, accepted: true, started }
    } catch (error) {
        return {
            ...queued,
            accepted: true,
            startError: error instanceof Error ? error.message : String(error)
        }
    }
}
