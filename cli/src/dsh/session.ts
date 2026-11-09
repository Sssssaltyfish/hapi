import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { DshMode } from './types'

/** Remote-only HAPI session wrapper for the DSH ACP server. */
export class DshSession extends AgentSessionBase<DshMode> {
    readonly startedBy: 'runner' | 'terminal'
    private queuedSteerHandler: ((payload: unknown) => Promise<unknown>) | null = null

    registerQueuedSteerHandler(handler: (payload: unknown) => Promise<unknown>): () => void {
        this.queuedSteerHandler = handler
        return () => { if (this.queuedSteerHandler === handler) this.queuedSteerHandler = null }
    }

    requestQueuedSteer(localId: string): void {
        void this.queuedSteerHandler?.({ localId }).catch(() => {})
    }

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        /** Spawn-time model override (opaque ACP config-option value). */
        model?: string
        messageQueue: MessageQueue2<DshMode>
        onModeChange: (mode: 'local' | 'remote') => void
        startedBy: 'runner' | 'terminal'
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: null,
            model: opts.model,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: 'remote',
            sessionLabel: 'DshSession',
            sessionIdLabel: 'DeepSeek Harness ACP',
            applySessionIdToMetadata: (metadata, sessionId) => ({ ...metadata, dshSessionId: sessionId })
        })
        this.startedBy = opts.startedBy
    }

    setModel = (model: string | null): void => {
        this.model = model;
    };

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
