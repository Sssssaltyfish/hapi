import { codexRecap } from '@hapi/protocol/codexManagement';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';

type Event = { method: string; params?: unknown };
/** A separate side client keeps hidden helper events out of the session's history projection. */
export async function sharedCodexRecap(options: {
    endpoint: string; token?: string; cwd: string; threadId: string;
    settings: Record<string, unknown>; signal: AbortSignal;
    subscribeSource(listener: (event: Event) => void): () => void;
}): Promise<string> {
    const client = new CodexAppServerClient({ endpoint: options.endpoint, token: options.token, cwd: options.cwd });
    const listeners = new Set<(event: Event) => void>();
    const emit = (event: Event) => { for (const listener of listeners) listener(event); };
    client.setNotificationHandler((method, params) => emit({ method, params }));
    client.setTransportAbandonedHandler(() => emit({ method: 'hapi/disconnected' }));
    client.setServerRequestHandler(request => emit({ method: 'hapi/request', params: request }));
    try {
        await initializeSharedClient(client);
        const result = await codexRecap({
            request: (method, params) => client.request(method, params),
            subscribe: listener => {
                listeners.add(listener);
                const removeSource = options.subscribeSource(listener);
                return () => { listeners.delete(listener); removeSource(); };
            },
            rejectRequest: id => client.respondError(id, { code: -32601, message: 'Recap helpers do not accept interaction requests' }),
        }, options.threadId, { settings: options.settings, signal: options.signal });
        return result.text;
    } finally {
        client.setNotificationHandler(null);
        client.setTransportAbandonedHandler(null);
        client.setServerRequestHandler(null);
        await client.disconnect();
    }
}
