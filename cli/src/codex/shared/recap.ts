import { codexRecap, codexSideQuestion, type CodexStructuredRequestTransport } from '@hapi/protocol/codexManagement';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';

type Event = { method: string; params?: unknown };
type SideClientOptions = {
    endpoint: string; token?: string; cwd: string; threadId: string;
    settings: Record<string, unknown>; signal: AbortSignal;
};

/** A separate side client keeps hidden helper events out of the session's history projection. */
async function withSideClient<T>(options: SideClientOptions, run: (transport: CodexStructuredRequestTransport) => Promise<T>): Promise<T> {
    options.signal.throwIfAborted();
    const client = new CodexAppServerClient({ endpoint: options.endpoint, token: options.token, cwd: options.cwd });
    const listeners = new Set<(event: Event) => void>();
    const emit = (event: Event) => { for (const listener of listeners) listener(event); };
    client.setNotificationHandler((method, params) => emit({ method, params }));
    client.setTransportAbandonedHandler(() => emit({ method: 'hapi/disconnected' }));
    client.setServerRequestHandler(request => emit({ method: 'hapi/request', params: request }));
    try {
        await initializeSharedClient(client);
        return await run({
            request: (method, params) => client.request(method, params),
            subscribe: listener => {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            rejectRequest: id => client.respondError(id, { code: -32601, message: 'Temporary helpers do not accept interaction requests' }),
        });
    } finally {
        client.setNotificationHandler(null);
        client.setTransportAbandonedHandler(null);
        client.setServerRequestHandler(null);
        await client.disconnect();
    }
}

export async function sharedCodexRecap(options: SideClientOptions): Promise<string> {
    const result = await withSideClient(options, transport => codexRecap(
        transport, options.threadId, { settings: options.settings, signal: options.signal },
    ));
    return result.text;
}

export function sharedCodexSideQuestion(options: SideClientOptions, question: string) {
    return withSideClient(options, transport => codexSideQuestion(
        transport, options.threadId, question, { settings: options.settings, signal: options.signal, timeoutMs: 60_000 },
    ));
}
