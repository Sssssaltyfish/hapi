import type { SyncEvent } from '@hapi/protocol';
import type { Store } from '../store';

/** A lost worker/Hub connection makes a dispatch unconfirmed, never replayable. */
export function recoverPendingSteering(store: Store, sessionId: string, emit: (event: SyncEvent) => void): void {
    const session = store.sessions.getSession(sessionId);
    if (!session) return;
    const localIds = store.messages.getUninvokedLocalMessages(sessionId)
        .filter(message => message.deliveryState === 'dispatching')
        .flatMap(message => message.localId ? [message.localId] : []);
    if (!localIds.length) return;
    store.recordMessagesIndeterminate(sessionId, localIds, session.namespace);
    emit({ type: 'messages-indeterminate', sessionId, localIds });
}
