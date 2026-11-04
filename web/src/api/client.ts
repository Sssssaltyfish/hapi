import type {
    AttachmentMetadata,
    AuthResponse,
    CodexLocalSessionsResponse,
    CodexDuplicateSessionsResponse,
    CodexMergeDuplicateSessionsResponse,
    CodexDesktopScriptResponse,
    CodexDesktopSyncRequest,
    CodexDesktopStatusResponse,
    CodexArchiveSessionResponse,
    DecryptedMessage,
    CodexCollaborationMode,
    CopilotAgentMode,
    FileSearchResponse,
    MachinesResponse,
    MessagesResponse,
    PermissionMode,
    PiImportSessionsResponse,
    PiLocalSessionsResponse,
    PushSubscriptionPayload,
    PushUnsubscribePayload,
    PushVapidPublicKeyResponse,
    SlashCommandsResponse,
    SkillsResponse,
    SpawnResponse,
    VisibilityPayload,
    HapiSessionExportResponse,
    HubHealthResponse,
    SessionResponse,
    SessionTitleSuggestionResponse,
    SessionsResponse
} from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type {
    AgyModelsResponse,
    AgentAvailabilityResponse,
    CodexModelsResponse,
    CursorMigrateOutcome,
    CursorMigrateToAcpRequest,
    CursorChatStoreStatus,
    CursorModelsResponse,
    DeleteUploadResponse,
    DshModelsResponse,
    FileReadResponse,
    GitCommandResponse,
    GrokModelsResponse,
    KimiModelsResponse,
    CopilotModelsResponse,
    GrokReasoningEffortResponse,
    ListDirectoryResponse,
    MachineListDirectoryResponse,
    MachinePathsExistsResponse,
    OpencodeModelsResponse,
    OpencodeModelVariantsResponse,
    OpencodeReasoningEffortResponse,
    PiModelsResponse,
    QueuedStateResponse,
    ReopenSessionResponse,
    SqliteStorageUsageResponse,
    HubSettingsResponse,
    UpdateHubSettingsRequest,
    UsageSummaryResponse,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'
import { fetchThroughAuthProxy } from '@/api/authProxy'
import type {
    NativeEndpoint,
    NativeEndpointStatus,
    NativeDaemonProject,
    NativeDirectory,
    NativeEvent,
    NativeItemEntry,
    NativePage,
    NativeRecord,
    NativeStatus,
    NativeThreadPage,
    NativeTurnContextPage
} from '@/codex-native/types'
import type { AgentFlavor, MessageDeliveryMode } from '@hapi/protocol'
import type { ConversationOutlineContinuation, ConversationOutlinePage } from '@/chat/outline'
import type { CancelMessageResponse, SteerQueuedMessageResponse } from '@hapi/protocol/schemas'
import type { TranscriptionMode, TranscriptionProvider, TranscriptionProviderInfo } from '@hapi/protocol/voice'

export type RetryIndeterminateMessageResponse =
    | { status: 'retried' | 'already-queued' | 'retry-unavailable'; localId: string | null }
    | { status: 'invoked'; message: DecryptedMessage }
    | { status: 'not-found' }

export type ProviderCredentialSource = 'env' | 'settings' | 'none'

export interface MaskedCredentialStatus {
    configured: boolean
    source: ProviderCredentialSource
    hint: string | null
    editable: boolean
}

export interface TranscriptionCredentialStatus {
    openai: MaskedCredentialStatus
    elevenlabs: MaskedCredentialStatus
    deepgram: MaskedCredentialStatus
    groq: MaskedCredentialStatus
    openaiCompatible: {
        configured: boolean
        source: ProviderCredentialSource
        baseUrl: string | null
        model: string | null
        baseUrlEditable: boolean
        modelEditable: boolean
        apiKey: MaskedCredentialStatus
    }
    voiceBackends: {
        elevenlabs: MaskedCredentialStatus
        geminiLive: MaskedCredentialStatus
        qwenRealtime: MaskedCredentialStatus
    }
    /** Optional: older hub versions won't send this. */
    elevenLabsMaxDurationSeconds?: {
        value: number
        source: ProviderCredentialSource
        editable: boolean
    }
}

export interface TranscriptionCredentialsUpdate {
    openai?: string | null
    elevenlabs?: string | null
    deepgram?: string | null
    groq?: string | null
    openaiCompatible?: {
        baseUrl?: string | null
        model?: string | null
        apiKey?: string | null
    }
    geminiLive?: string | null
    qwenRealtime?: string | null
    /** null resets to the hub default (1800s) */
    elevenLabsMaxDurationSeconds?: number | null
}

type ApiClientOptions = {
    baseUrl?: string
    getToken?: () => string | null
    onUnauthorized?: () => Promise<string | null>
}

type ErrorPayload = {
    error?: unknown
    code?: unknown
}

function parseErrorCode(bodyText: string): string | undefined {
    try {
        const parsed = JSON.parse(bodyText) as ErrorPayload
        if (typeof parsed.code === 'string') return parsed.code
        if (typeof parsed.error === 'string') return parsed.error
        return undefined
    } catch {
        return undefined
    }
}

export type RunnerMessageContext = {
    message: DecryptedMessage
    page: MessagesResponse
    position: { at: number; seq: number }
    epoch: number
}

export type NativeTurnItemsOptions = {
    cursor?: string | { type: 'item'; itemId: string }
    sortDirection?: 'asc' | 'desc'
    limit?: number
    signal?: AbortSignal
}

export class ApiError extends Error {
    status: number
    code?: string
    body?: string

    constructor(message: string, status: number, code?: string, body?: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.body = body
    }
}

export class ApiClient {
    private token: string
    private readonly baseUrl: string | null
    private readonly getToken: (() => string | null) | null
    private readonly onUnauthorized: (() => Promise<string | null>) | null
    private nativeEndpointId: string | null = null
    private outlineIdentityToken: string | null = null
    private outlineIdentityKey = Math.random().toString(36)

    constructor(token: string, options?: ApiClientOptions) {
        this.token = token
        this.baseUrl = options?.baseUrl ?? null
        this.getToken = options?.getToken ?? null
        this.onUnauthorized = options?.onUnauthorized ?? null
    }

    private buildUrl(path: string): string {
        if (this.nativeEndpointId && path.startsWith('/api/codex-native/')) {
            const separator = path.includes('?') ? '&' : '?'
            path += `${separator}endpointId=${encodeURIComponent(this.nativeEndpointId)}`
        }
        if (!this.baseUrl) {
            return path
        }
        try {
            return new URL(path, this.baseUrl).toString()
        } catch {
            return path
        }
    }

    private async request<T>(
        path: string,
        init?: RequestInit,
        attempt: number = 0,
        overrideToken?: string | null
    ): Promise<T> {
        const headers = new Headers(init?.headers)
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined
            ? (overrideToken ?? (liveToken ?? this.token))
            : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
            headers.set('content-type', 'application/json')
        }

        const res = await fetchThroughAuthProxy(this.buildUrl(path), {
            ...init,
            headers
        })

        if (res.status === 401) {
            if (attempt === 0 && this.onUnauthorized) {
                const refreshed = await this.onUnauthorized()
                if (refreshed) {
                    this.token = refreshed
                    return await this.request<T>(path, init, attempt + 1, refreshed)
                }
            }
            throw new Error('Session expired. Please sign in again.')
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            throw new ApiError(
                `HTTP ${res.status} ${res.statusText}: ${body}`,
                res.status,
                code,
                body || undefined
            )
        }

        return await res.json() as T
    }

    async authenticate(auth: { initData: string } | { accessToken: string }): Promise<AuthResponse> {
        const res = await fetchThroughAuthProxy(this.buildUrl('/api/auth'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Auth failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async bind(auth: { initData: string; accessToken: string }): Promise<AuthResponse> {
        const res = await fetchThroughAuthProxy(this.buildUrl('/api/bind'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Bind failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async getSessions(options?: { nativeEndpointId: string; nativeCursor?: string; nativeCatalog?: 'background' }): Promise<SessionsResponse> {
        const params = new URLSearchParams()
        if (options) for (const [key, value] of Object.entries(options)) if (value) params.set(key, value)
        return await this.request<SessionsResponse>(`/api/sessions${params.size ? `?${params}` : ''}`)
    }

    async getCodexNativeStatus(): Promise<NativeStatus> {
        return await this.request('/api/codex-native/status')
    }

    withCodexNativeEndpoint(endpointId: string): ApiClient {
        const client = new ApiClient(this.token, { baseUrl: this.baseUrl ?? undefined, getToken: this.getToken ?? undefined, onUnauthorized: this.onUnauthorized ?? undefined })
        client.nativeEndpointId = endpointId
        return client
    }

    async getCodexNativeEndpoints(): Promise<{ endpoints: NativeEndpoint[] }> {
        return await this.request('/api/codex-native/endpoints')
    }

    async resolveCodexNativeThreadReference(reference: { threadId: string; hostId?: string; targetEndpointId?: string }, signal?: AbortSignal): Promise<{ sessionId: string; endpointId: string; threadId: string; hostId: string | null }> {
        const params = new URLSearchParams({ threadId: reference.threadId })
        if (reference.hostId) params.set('hostId', reference.hostId)
        if (reference.targetEndpointId) params.set('targetEndpointId', reference.targetEndpointId)
        return this.request(`/api/codex-native/thread-reference?${params}`, { signal })
    }

    async getCodexNativeReferenceCapabilities(threadId: string, signal?: AbortSignal): Promise<{ readThread: boolean }> {
        return this.request(`/api/codex-native/threads/${encodeURIComponent(threadId)}/reference-capabilities`, { signal })
    }

    async createCodexNativeEndpoint(payload: {
        address: string
        displayName?: string
        token?: string
        defaultCwd?: string
    }): Promise<{ endpoint: NativeEndpoint }> {
        return await this.request('/api/codex-native/endpoints', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async renameCodexNativeEndpoint(endpointId: string, displayName: string): Promise<{ endpoint: NativeEndpoint }> {
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ displayName })
        })
    }

    async getCodexNativeEndpointStatus(endpointId: string): Promise<NativeEndpointStatus> {
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}/status`)
    }

    async getCodexNativeSuggestions(
        threadId: string,
        query: string,
        signal?: AbortSignal
    ): Promise<{ suggestions: Suggestion[]; canReferenceThreads?: boolean }> {
        return await this.request(
            `/api/codex-native/threads/${encodeURIComponent(threadId)}/suggestions?${new URLSearchParams({ query })}`,
            { signal }
        )
    }

    async listCodexNativeProjects(endpointId: string, cursor?: string): Promise<NativePage<NativeDaemonProject>> {
        const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}/projects${query}`)
    }

    async createCodexNativeProject(endpointId: string, payload: { name: string; path: string; idempotencyKey: string }): Promise<{ project: NativeDaemonProject }> {
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}/projects`, { method: 'POST', body: JSON.stringify(payload) })
    }

    async listCodexNativeDirectory(endpointId: string, path: string, includeHidden = false): Promise<NativeDirectory> {
        const query = new URLSearchParams({ path, includeHidden: String(includeHidden) })
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}/directory?${query}`)
    }

    async createCodexNativeThread(endpointId: string, payload: { cwd: string; projectId?: string | null; model?: string; effort?: string }): Promise<{ session: import('@/types/api').Session; thread: NativeRecord }> {
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}/threads`, { method: 'POST', body: JSON.stringify(payload) })
    }

    async readCodexNativeFile(endpointId: string, threadId: string, path: string): Promise<FileReadResponse> {
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}/threads/${encodeURIComponent(threadId)}/file?${new URLSearchParams({ path })}`)
    }

    async readCodexNativeDirectory(endpointId: string, threadId: string, path: string): Promise<{ entries: { fileName: string; isDirectory: boolean; isFile: boolean }[] }> {
        return await this.request(`/api/codex-native/endpoints/${encodeURIComponent(endpointId)}/threads/${encodeURIComponent(threadId)}/directory?${new URLSearchParams({ path })}`)
    }

    async getCodexNativeThreads(options: { projectId?: string; cursor?: string; catalog?: 'main' | 'background' } = {}): Promise<NativeThreadPage> {
        const params = new URLSearchParams({ limit: '50' })
        for (const [key, value] of Object.entries(options)) if (value) params.set(key, value)
        return await this.request(`/api/codex-native/threads?${params}`)
    }

    async getCodexNativeThread(id: string): Promise<NativeRecord> {
        return await this.request(`/api/codex-native/threads/${encodeURIComponent(id)}`)
    }

    async getCodexNativeActiveTurn(id: string): Promise<NativeRecord> {
        return await this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/active-turn`)
    }

    async uploadCodexNativeFile(threadId: string, filename: string, dataBase64: string, mimeType: string): Promise<UploadFileResponse> {
        return await this.request(`/api/codex-native/threads/${encodeURIComponent(threadId)}/attachments`, {
            method: 'POST', body: JSON.stringify({ filename, dataBase64, mimeType })
        })
    }

    async deleteCodexNativeUpload(threadId: string, path: string): Promise<DeleteUploadResponse> {
        return await this.request(`/api/codex-native/threads/${encodeURIComponent(threadId)}/attachments`, {
            method: 'DELETE', body: JSON.stringify({ path })
        })
    }

    async getCodexNativeItems(id: string, cursor?: string, sortDirection: 'asc' | 'desc' = 'desc', signal?: AbortSignal): Promise<NativePage<NativeItemEntry>> {
        const params = new URLSearchParams({ limit: '50' })
        if (cursor) params.set('cursor', cursor)
        if (sortDirection === 'asc') params.set('sortDirection', sortDirection)
        return await this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/items?${params}`, { signal })
    }

    async getCodexNativeTurnContext(id: string, turnId: string, itemId: string, signal?: AbortSignal): Promise<NativeTurnContextPage> {
        const params = new URLSearchParams({ turnId, itemId })
        return this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/outline-context?${params}`, { signal })
    }

    async getCodexNativeItem(id: string, turnId: string, itemId: string, signal?: AbortSignal): Promise<{ entry: NativeItemEntry }> {
        const params = new URLSearchParams({ turnId })
        return this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}?${params}`, { signal })
    }

    async getCodexNativeTurnItems(id: string, turnId: string, options: NativeTurnItemsOptions = {}): Promise<NativePage<NativeItemEntry>> {
        const { signal, ...params } = options
        return this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/turn-items/read`, {
            method: 'POST', body: JSON.stringify({ turnId, ...params }), signal,
        })
    }

    async getRunnerMessageContext(sessionId: string, rawMessageId: string, signal?: AbortSignal): Promise<RunnerMessageContext> {
        return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(rawMessageId)}/context`, { signal })
    }

    /** Only a stable authenticated principal can own a persistent prompt index. */
    getConversationCacheScope(): { key: string; persistent: boolean } {
        const token = this.getToken?.() ?? this.token
        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
            if (typeof payload.ns === 'string' && (typeof payload.uid === 'string' || typeof payload.uid === 'number')) {
                const origin = this.baseUrl ?? globalThis.location?.origin ?? 'local'
                return { key: JSON.stringify([origin, payload.ns, payload.uid]), persistent: true }
            }
        } catch { /* Unidentified clients keep their cache in memory only. */ }
        if (token !== this.outlineIdentityToken) {
            this.outlineIdentityToken = token
            this.outlineIdentityKey = Math.random().toString(36)
        }
        return { key: this.outlineIdentityKey, persistent: false }
    }

    async getConversationOutline(id: string, locator: ConversationOutlineContinuation, stopId?: string | string[]): Promise<ConversationOutlinePage> {
        const params = new URLSearchParams()
        if (Array.isArray(stopId)) params.set('stopIds', JSON.stringify(stopId))
        else if (stopId) params.set('stopId', stopId)
        if (locator.kind === 'native-turns') {
            if (locator.cursor) params.set('cursor', locator.cursor)
            return this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/outline?${params}`)
        }
        if (locator.beforeAt !== null && locator.beforeSeq !== null) {
            params.set('beforeAt', String(locator.beforeAt))
            params.set('beforeSeq', String(locator.beforeSeq))
        }
        if (locator.epoch !== null) params.set('epoch', String(locator.epoch))
        return this.request(`/api/sessions/${encodeURIComponent(id)}/outline?${params}`)
    }

    async getCodexNativeModels(): Promise<NativePage<NativeRecord>> {
        return await this.request('/api/codex-native/models')
    }

    async getCodexNativeQueue(id: string, cursor?: string): Promise<NativePage<NativeRecord>> {
        const params = new URLSearchParams({ limit: '100' })
        if (cursor) params.set('cursor', cursor)
        return await this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/queue?${params}`)
    }

    async codexNativeAction(id: string, action: 'settings' | 'messages' | 'interrupt' | 'queue/delete' | 'queue/steer' | `requests/${string}`, payload: NativeRecord): Promise<NativeRecord> {
        return await this.request(`/api/codex-native/threads/${encodeURIComponent(id)}/${action}`, {
            method: 'POST', body: JSON.stringify(payload)
        })
    }

    async streamCodexNativeEvents(id: string, signal: AbortSignal, onEvent: (event: NativeEvent) => void): Promise<void> {
        const path = `/api/codex-native/threads/${encodeURIComponent(id)}/events`
        let token = this.getToken?.() ?? this.token
        let response = await fetchThroughAuthProxy(this.buildUrl(path), { headers: { authorization: `Bearer ${token}` }, signal })
        if (response.status === 401 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                token = refreshed
                response = await fetchThroughAuthProxy(this.buildUrl(path), { headers: { authorization: `Bearer ${token}` }, signal })
            }
        }
        if (!response.ok || !response.body) throw new ApiError('Native event stream unavailable', response.status)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
            while (!signal.aborted) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
                let boundary: number
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, boundary)
                    buffer = buffer.slice(boundary + 2)
                    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
                    if (data) onEvent(JSON.parse(data) as NativeEvent)
                }
            }
        } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    }

    async getHealth(): Promise<HubHealthResponse> {
        return await this.request<HubHealthResponse>('/health')
    }

    async getPushVapidPublicKey(): Promise<PushVapidPublicKeyResponse> {
        return await this.request<PushVapidPublicKeyResponse>('/api/push/vapid-public-key')
    }

    async subscribePushNotifications(payload: PushSubscriptionPayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async syncCodexSession(payload?: CodexDesktopSyncRequest): Promise<CodexDesktopScriptResponse> {
        // 中文注释：当前按钮语义已改为“从 Codex 导入到 Hapi”；这里提交的是本地 transcript 对应的 Codex thread ID 列表。
        return await this.request<CodexDesktopScriptResponse>('/api/codex/sync-session', {
            method: 'POST',
            ...(payload ? { body: JSON.stringify(payload) } : {})
        })
    }

    async getCodexSessions(cwd?: string | null, machineId?: string | null): Promise<CodexLocalSessionsResponse> {
        const params = new URLSearchParams()
        if (cwd?.trim()) params.set('cwd', cwd.trim())
        if (machineId?.trim()) params.set('machineId', machineId.trim())
        const query = params.size ? `?${params.toString()}` : ''
        return await this.request<CodexLocalSessionsResponse>(`/api/codex/sessions${query}`)
    }

    async getPiSessions(cwd?: string | null, machineId?: string | null): Promise<PiLocalSessionsResponse> {
        const params = new URLSearchParams()
        if (cwd?.trim()) params.set('cwd', cwd.trim())
        if (machineId?.trim()) params.set('machineId', machineId.trim())
        const query = params.size ? `?${params.toString()}` : ''
        return await this.request<PiLocalSessionsResponse>(`/api/pi/sessions${query}`)
    }

    async importPiSessions(payload: { sessionIds: string[]; cwd?: string | null; machineId?: string | null }): Promise<PiImportSessionsResponse> {
        return await this.request<PiImportSessionsResponse>('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async archiveCodexSession(sessionId: string, machineId?: string | null): Promise<CodexArchiveSessionResponse> {
        return await this.request<CodexArchiveSessionResponse>('/api/codex/archive-session', {
            method: 'POST',
            body: JSON.stringify({ sessionId, machineId: machineId ?? undefined })
        })
    }

    async getCodexDesktopStatus(): Promise<CodexDesktopStatusResponse> {
        return await this.request<CodexDesktopStatusResponse>('/api/codex/status')
    }

    async getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): Promise<CodexDuplicateSessionsResponse> {
        // 中文注释：重复会话检测只传本次用户勾选导入的 codexSessionId，避免把未选中的历史会话也纳入提示。
        return await this.request<CodexDuplicateSessionsResponse>('/api/codex/duplicate-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): Promise<CodexMergeDuplicateSessionsResponse> {
        // 中文注释：真正执行合并时沿用同一批选中 codexSessionId，保证检测范围与执行范围一致。
        return await this.request<CodexMergeDuplicateSessionsResponse>('/api/codex/merge-duplicate-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async restartCodexDesktop(): Promise<CodexDesktopScriptResponse> {
        return await this.request<CodexDesktopScriptResponse>('/api/codex/restart-desktop', {
            method: 'POST'
        })
    }

    async unsubscribePushNotifications(payload: PushUnsubscribePayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'DELETE',
            body: JSON.stringify(payload)
        })
    }

    async setVisibility(payload: VisibilityPayload): Promise<void> {
        await this.request('/api/visibility', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async getSession(sessionId: string): Promise<SessionResponse> {
        return await this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    }

    async getSessionExport(
        sessionId: string,
        options?: { force?: boolean; signal?: AbortSignal }
    ): Promise<HapiSessionExportResponse> {
        const query = options?.force ? '?force=true' : ''
        return await this.request<HapiSessionExportResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/export${query}`,
            { signal: options?.signal }
        )
    }

    async getMessages(
        sessionId: string,
        options: {
            beforeSeq?: number | null
            beforeAt?: number | null
            afterSeq?: number | null
            afterAt?: number | null
            untilSeq?: number | null
            untilAt?: number | null
            epoch?: number | null
            limit?: number
        },
        signal?: AbortSignal
    ): Promise<MessagesResponse> {
        const params = new URLSearchParams()
        if (options.beforeAt !== undefined && options.beforeAt !== null) {
            params.set('beforeAt', `${options.beforeAt}`)
        }
        if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
            params.set('beforeSeq', `${options.beforeSeq}`)
        }
        if (options.afterAt !== undefined && options.afterAt !== null) {
            params.set('afterAt', `${options.afterAt}`)
        }
        if (options.afterSeq !== undefined && options.afterSeq !== null) {
            params.set('afterSeq', `${options.afterSeq}`)
        }
        if (options.untilAt !== undefined && options.untilAt !== null) {
            params.set('untilAt', `${options.untilAt}`)
        }
        if (options.untilSeq !== undefined && options.untilSeq !== null) {
            params.set('untilSeq', `${options.untilSeq}`)
        }
        if (options.epoch !== undefined && options.epoch !== null) {
            params.set('epoch', `${options.epoch}`)
        }
        if (options.limit !== undefined && options.limit !== null) {
            params.set('limit', `${options.limit}`)
        }

        const qs = params.toString()
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`
        return await this.request<MessagesResponse>(url, { signal })
    }

    async getGitStatus(sessionId: string): Promise<GitCommandResponse> {
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-status`)
    }

    async getGitDiffNumstat(sessionId: string, staged: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('staged', staged ? 'true' : 'false')
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat?${params.toString()}`)
    }

    async getGitDiffFile(sessionId: string, path: string, staged?: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        if (staged !== undefined) {
            params.set('staged', staged ? 'true' : 'false')
        }
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-file?${params.toString()}`)
    }

    async searchSessionFiles(sessionId: string, query: string, limit?: number): Promise<FileSearchResponse> {
        const params = new URLSearchParams()
        if (query) {
            params.set('query', query)
        }
        if (limit !== undefined) {
            params.set('limit', `${limit}`)
        }
        const qs = params.toString()
        return await this.request<FileSearchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/files${qs ? `?${qs}` : ''}`)
    }

    async getGeneratedImageBlob(sessionId: string, imageId: string, attempt: number = 0, overrideToken?: string | null): Promise<Blob> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined
            ? (overrideToken ?? (liveToken ?? this.token))
            : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const url = this.buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/generated-images/${encodeURIComponent(imageId)}`)
        let res = await fetchThroughAuthProxy(url, { headers })
        // Hub returns ETag + immutable Cache-Control (#927). Default fetch cache stores 200
        // responses so remounts avoid RPC; on 304 the body is empty — read from cache.
        if (res.status === 304) {
            res = await fetchThroughAuthProxy(url, { headers, cache: 'force-cache' })
        }
        if (res.status === 401 && attempt === 0 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                return await this.getGeneratedImageBlob(sessionId, imageId, attempt + 1, refreshed)
            }
        }
        if (!res.ok) {
            throw new ApiError(`HTTP ${res.status}`, res.status, undefined, await res.text().catch(() => undefined))
        }
        return await res.blob()
    }

    async readSessionFile(sessionId: string, path: string): Promise<FileReadResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        return await this.request<FileReadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/file?${params.toString()}`)
    }

    async listSessionDirectory(sessionId: string, path?: string): Promise<ListDirectoryResponse> {
        const params = new URLSearchParams()
        if (path) {
            params.set('path', path)
        }

        const qs = params.toString()
        return await this.request<ListDirectoryResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/directory${qs ? `?${qs}` : ''}`
        )
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<UploadFileResponse> {
        return await this.request<UploadFileResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload`, {
            method: 'POST',
            body: JSON.stringify({ filename, content, mimeType })
        })
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<DeleteUploadResponse> {
        return await this.request<DeleteUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload/delete`, {
            method: 'POST',
            body: JSON.stringify({ path })
        })
    }

    async resumeSession(sessionId: string, opts?: { permissionMode?: string }): Promise<string> {
        const response = await this.request<{ sessionId: string }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/resume`,
            {
                method: 'POST',
                ...(opts?.permissionMode !== undefined && {
                    body: JSON.stringify({ permissionMode: opts.permissionMode })
                })
            }
        )
        return response.sessionId
    }

    async getCursorChatStoreStatus(sessionId: string): Promise<CursorChatStoreStatus> {
        return await this.request<CursorChatStoreStatus>(
            `/api/sessions/${encodeURIComponent(sessionId)}/cursor-chat-store`
        )
    }

    async sendMessage(
        sessionId: string,
        text: string,
        localId?: string | null,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                text,
                localId: localId ?? undefined,
                attachments: attachments ?? undefined,
                scheduledAt: scheduledAt ?? undefined,
                deliveryMode: deliveryMode ?? undefined,
            })
        })
    }

    async getQueuedState(sessionId: string, localIds: string[]): Promise<QueuedStateResponse> {
        return await this.request<QueuedStateResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/queued-state`,
            {
                method: 'POST',
                body: JSON.stringify({ localIds })
            }
        )
    }

    async cancelMessage(sessionId: string, messageId: string): Promise<CancelMessageResponse> {
        const response = await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
            { method: 'DELETE' }
        )
        return response as CancelMessageResponse
    }

    async steerMessage(sessionId: string, messageId: string): Promise<SteerQueuedMessageResponse> {
        const response = await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/steer`,
            { method: 'POST' }
        )
        return response as SteerQueuedMessageResponse
    }

    async retryIndeterminateMessage(sessionId: string, messageId: string): Promise<RetryIndeterminateMessageResponse> {
        return await this.request<RetryIndeterminateMessageResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/retry`,
            { method: 'POST' }
        )
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async clearConversation(sessionId: string): Promise<{ sessionId: string }> {
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/clear`, { method: 'POST' })
    }

    async implementCodexPlan(sessionId: string, planId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/codex/plan/implement`, {
            method: 'POST', body: JSON.stringify({ planId })
        })
    }

    async forkConversation(sessionId: string, messageLocalId?: string): Promise<{ sessionId: string }> {
        return await this.request<{ sessionId: string }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
            {
                method: 'POST',
                body: JSON.stringify(messageLocalId ? { messageLocalId } : {})
            }
        )
    }

    async rewindConversation(sessionId: string, messageLocalId: string): Promise<{ success: true }> {
        return await this.request<{ success: true }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/rewind`,
            {
                method: 'POST',
                body: JSON.stringify({ messageLocalId })
            }
        )
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async reopenSession(sessionId: string): Promise<ReopenSessionResponse> {
        return await this.request<ReopenSessionResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/reopen`,
            { method: 'POST', body: JSON.stringify({}) }
        )
    }

    /**
     * Migrate a legacy stream-json Cursor session to ACP. See tiann/hapi#824.
     *
     * Refusals (e.g. running session, missing on-disk store, target collision)
     * are returned as structured `{ok: false, reason, message}` outcomes
     * rather than thrown - the UI surfaces the reason to the operator and the
     * underlying state on disk is unchanged.
     *
     * 401s trigger the same onUnauthorized refresh path as the shared
     * `request()` helper so an expired JWT silently re-auths instead of
     * hard-failing the migration dialog (Codex review #34 P2).
     */
    async migrateCursorSessionToAcp(sessionId: string, body: CursorMigrateToAcpRequest = {}): Promise<CursorMigrateOutcome> {
        const path = `/api/sessions/${encodeURIComponent(sessionId)}/migrate-to-acp`
        const tryOnce = async (overrideToken: string | null): Promise<Response> => {
            const headers = new Headers({ 'content-type': 'application/json' })
            const liveToken = this.getToken ? this.getToken() : null
            const authToken = overrideToken ?? liveToken ?? this.token
            if (authToken) {
                headers.set('authorization', `Bearer ${authToken}`)
            }
            return fetchThroughAuthProxy(this.buildUrl(path), { method: 'POST', headers, body: JSON.stringify(body) })
        }

        let res = await tryOnce(null)
        if (res.status === 401 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                res = await tryOnce(refreshed)
            }
        }
        if (res.status === 401) {
            throw new Error('Session expired. Please sign in again.')
        }
        const text = await res.text()
        let parsed: CursorMigrateOutcome | null = null
        try {
            parsed = text ? JSON.parse(text) as CursorMigrateOutcome : null
        } catch {
            parsed = null
        }
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            return parsed
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`)
    }

    async switchSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/switch`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/config-option`, {
            method: 'POST',
            body: JSON.stringify({ configId, value })
        })
    }

    async setCollaborationMode(sessionId: string, mode: CodexCollaborationMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/collaboration-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setModel(sessionId: string, model: { provider: string; modelId: string } | string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
            method: 'POST',
            body: JSON.stringify({ model })
        })
    }

    async setModelReasoningEffort(sessionId: string, modelReasoningEffort: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model-reasoning-effort`, {
            method: 'POST',
            body: JSON.stringify({ modelReasoningEffort })
        })
    }

    async setEffort(sessionId: string, effort: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/effort`, {
            method: 'POST',
            body: JSON.stringify({ effort })
        })
    }

    async setServiceTier(sessionId: string, serviceTier: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/service-tier`, {
            method: 'POST',
            body: JSON.stringify({ serviceTier })
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        modeOrOptions?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan' | {
            mode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'
            allowTools?: string[]
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
            answers?: Record<string, string[]> | Record<string, { answers: string[] }>
        }
    ): Promise<void> {
        const body = typeof modeOrOptions === 'string' || modeOrOptions === undefined
            ? { mode: modeOrOptions }
            : modeOrOptions
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`, {
            method: 'POST',
            body: JSON.stringify(body)
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        options?: {
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
        }
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`, {
            method: 'POST',
            body: JSON.stringify(options ?? {})
        })
    }

    async getMachines(): Promise<MachinesResponse> {
        return await this.request<MachinesResponse>('/api/machines')
    }

    /** Pass an empty string to clear the custom name and fall back to the hostname. */
    async renameMachine(machineId: string, displayName: string): Promise<void> {
        await this.request(`/api/machines/${encodeURIComponent(machineId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ displayName })
        })
    }

    async getSqliteStorageUsage(): Promise<SqliteStorageUsageResponse> {
        return await this.request<SqliteStorageUsageResponse>('/api/storage/sqlite')
    }

    async getHubSettings(): Promise<HubSettingsResponse> {
        return await this.request<HubSettingsResponse>('/api/hub-settings')
    }

    async updateHubSettings(settings: UpdateHubSettingsRequest): Promise<HubSettingsResponse> {
        return await this.request<HubSettingsResponse>('/api/hub-settings', {
            method: 'PUT',
            body: JSON.stringify(settings)
        })
    }

    async getUsageSummary(
        range: '7d' | '30d' | 'all' = '7d',
        timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    ): Promise<UsageSummaryResponse> {
        const params = new URLSearchParams({
            range,
            timeZone
        })
        return await this.request<UsageSummaryResponse>(`/api/usage/summary?${params.toString()}`)
    }

    async restartMachineRunner(machineId: string): Promise<{ message: string }> {
        return await this.request<{ message: string }>(
            `/api/machines/${encodeURIComponent(machineId)}/restart-runner`,
            { method: 'POST', body: '{}' }
        )
    }

    async listMachineDirectory(
        machineId: string,
        path: string,
        options?: { includeHidden?: boolean }
    ): Promise<MachineListDirectoryResponse> {
        return await this.request<MachineListDirectoryResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/list-directory`,
            {
                method: 'POST',
                body: JSON.stringify({ path, includeHidden: options?.includeHidden === true })
            }
        )
    }

    async getMachineAgentAvailability(machineId: string): Promise<AgentAvailabilityResponse> {
        return await this.request<AgentAvailabilityResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/agent-availability`
        )
    }

    async checkMachinePathsExists(
        machineId: string,
        paths: string[]
    ): Promise<MachinePathsExistsResponse> {
        return await this.request<MachinePathsExistsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/paths/exists`,
            {
                method: 'POST',
                body: JSON.stringify({ paths })
            }
        )
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent?: AgentFlavor,
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: 'fast' | 'standard',
        collaborationMode?: CodexCollaborationMode,
        copilotAgentMode?: CopilotAgentMode,
        startingMode?: 'remote' | 'pty'
    ): Promise<SpawnResponse> {
        return await this.request<SpawnResponse>(`/api/machines/${encodeURIComponent(machineId)}/spawn`, {
            method: 'POST',
            body: JSON.stringify({
                directory,
                agent,
                model,
                modelReasoningEffort,
                yolo,
                sessionType,
                worktreeName,
                effort,
                permissionMode,
                serviceTier,
                collaborationMode,
                copilotAgentMode,
                startingMode
            })
        })
    }

    async getMachineAgyModels(
        machineId: string,
        options?: { refresh?: boolean }
    ): Promise<AgyModelsResponse> {
        // Without `refresh` the machine may answer from its cached catalog.
        const query = options?.refresh ? '?refresh=true' : ''
        return await this.request<AgyModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/agy-models${query}`
        )
    }

    async getMachineDshModels(machineId: string): Promise<DshModelsResponse> {
        return await this.request<DshModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/dsh-models`
        )
    }

    async getMachinePiModels(machineId: string): Promise<PiModelsResponse> {
        return await this.request<PiModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/pi-models`
        )
    }

    async getMachineCodexModels(machineId: string): Promise<CodexModelsResponse> {
        return await this.request<CodexModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/codex-models`
        )
    }

    async getSessionCodexModels(sessionId: string): Promise<CodexModelsResponse> {
        return await this.request<CodexModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/codex-models`
        )
    }

    async getSessionOpencodeModels(sessionId: string): Promise<OpencodeModelsResponse> {
        return await this.request<OpencodeModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/opencode-models`
        )
    }

    async getSessionOpencodeReasoningEffortOptions(sessionId: string): Promise<OpencodeReasoningEffortResponse> {
        return await this.request<OpencodeReasoningEffortResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/opencode-reasoning-effort-options`
        )
    }

    async getSessionCursorModels(sessionId: string): Promise<CursorModelsResponse> {
        return await this.request<CursorModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/cursor-models`
        )
    }

    /** Generic Pi session endpoint — replaces per-method wrappers. */
    async callPiEndpoint<T = unknown>(sessionId: string, path: string, init?: RequestInit): Promise<T> {
        return await this.request<T>(
            `/api/sessions/${encodeURIComponent(sessionId)}/pi-${path}`,
            init
        )
    }

    async getMachineCursorModels(machineId: string): Promise<CursorModelsResponse> {
        return await this.request<CursorModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/cursor-models`
        )
    }

    async getMachineOpencodeModelsForCwd(machineId: string, cwd: string): Promise<OpencodeModelsResponse> {
        return await this.request<OpencodeModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/opencode-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getMachineOpencodeModelVariants(machineId: string, cwd?: string | null): Promise<OpencodeModelVariantsResponse> {
        return await this.request<OpencodeModelVariantsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/opencode-model-variants${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`
        )
    }

    async getMachineGrokModelsForCwd(machineId: string, cwd: string): Promise<GrokModelsResponse> {
        return await this.request<GrokModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/grok-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getMachineCopilotModelsForCwd(machineId: string, cwd: string): Promise<CopilotModelsResponse> {
        return await this.request<CopilotModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/copilot-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getMachineKimiModelsForCwd(machineId: string, cwd: string): Promise<KimiModelsResponse> {
        return await this.request<KimiModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/kimi-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getSessionKimiModels(sessionId: string): Promise<KimiModelsResponse> {
        return await this.request<KimiModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/kimi-models`
        )
    }

    async getSessionDshModels(sessionId: string): Promise<DshModelsResponse> {
        return await this.request<DshModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/dsh-models`
        )
    }

    async getSessionGrokModels(sessionId: string): Promise<GrokModelsResponse> {
        return await this.request<GrokModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/grok-models`
        )
    }

    async getSessionCopilotModels(sessionId: string): Promise<CopilotModelsResponse> {
        return await this.request<CopilotModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/copilot-models`
        )
    }

    async setCopilotAgentMode(sessionId: string, mode: CopilotAgentMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/copilot-agent-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async getSessionGrokReasoningEffortOptions(sessionId: string): Promise<GrokReasoningEffortResponse> {
        return await this.request<GrokReasoningEffortResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/grok-reasoning-effort-options`
        )
    }

    async getSlashCommands(sessionId: string): Promise<SlashCommandsResponse> {
        return await this.request<SlashCommandsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`
        )
    }

    async getSkills(sessionId: string): Promise<SkillsResponse> {
        return await this.request<SkillsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/skills`
        )
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name })
        })
    }

    async suggestSessionTitle(sessionId: string): Promise<SessionTitleSuggestionResponse> {
        return await this.request<SessionTitleSuggestionResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/title-suggestion`,
            { method: 'POST' }
        )
    }

    async updateSessionSummary(sessionId: string, text: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/summary`, {
            method: 'PATCH',
            body: JSON.stringify({ text })
        })
    }

    async setSessionPinMode(sessionId: string, mode: 'none' | 'project' | 'global'): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
            method: 'PUT',
            body: JSON.stringify({ mode })
        })
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE'
        })
    }

    /*
     * Scratchlist v2 (tiann/hapi#893).
     *
     * The hub is the durable store; localStorage is demoted to an
     * offline cache. Mutations return the canonical entry so optimistic
     * updates can reconcile with the hub-stamped `updatedAt`.
     */

    async getScratchlist(sessionId: string): Promise<{
        entries: Array<{
            entryId: string
            text: string
            createdAt: number
            updatedAt: number
            attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }>
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist`
        )
    }

    async uploadScratchlistAttachment(
        sessionId: string,
        filename: string,
        content: string,
        mimeType: string
    ): Promise<{
        success: boolean
        attachment?: import('@hapi/protocol').ScratchlistAttachmentMetadata
        error?: string
        code?: string
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/upload`,
            {
                method: 'POST',
                body: JSON.stringify({ filename, content, mimeType })
            }
        )
    }

    async fetchScratchlistAttachmentBlob(sessionId: string, attachmentId: string): Promise<Blob> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = liveToken ?? this.token
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const response = await fetchThroughAuthProxy(
            this.buildUrl(
                `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/attachments/${encodeURIComponent(attachmentId)}`
            ),
            { headers }
        )
        if (!response.ok) {
            throw new ApiError(`Failed to fetch scratchlist attachment (${response.status})`, response.status)
        }
        return await response.blob()
    }

    async deleteScratchlistAttachment(sessionId: string, attachmentId: string): Promise<void> {
        await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/attachments/${encodeURIComponent(attachmentId)}`,
            { method: 'DELETE' }
        )
    }

    async createScratchlistEntry(
        sessionId: string,
        body: {
            text: string
            entryId?: string
            createdAt?: number
            attachments?: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    ): Promise<{
        entry: {
            entryId: string
            text: string
            createdAt: number
            updatedAt: number
            attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist`,
            {
                method: 'POST',
                body: JSON.stringify(body)
            }
        )
    }

    async updateScratchlistEntry(
        sessionId: string,
        entryId: string,
        text: string
    ): Promise<{
        entry: {
            entryId: string
            text: string
            createdAt: number
            updatedAt: number
            attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/${encodeURIComponent(entryId)}`,
            {
                method: 'PUT',
                body: JSON.stringify({ text })
            }
        )
    }

    async deleteScratchlistEntry(sessionId: string, entryId: string): Promise<void> {
        await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/${encodeURIComponent(entryId)}`,
            { method: 'DELETE' }
        )
    }

    async fetchVoiceToken(options?: { customAgentId?: string; customApiKey?: string; voiceId?: string }): Promise<{
        allowed: boolean
        token?: string
        agentId?: string
        error?: string
    }> {
        return await this.request('/api/voice/token', {
            method: 'POST',
            body: JSON.stringify(options || {})
        })
    }

    async fetchVoices(): Promise<{ voices: Array<{ id: string; name: string; previewUrl: string; category: string }> }> {
        return await this.request('/api/voice/voices')
    }

    async sendVoiceTelemetry(event: {
        stage: string
        message: string
        sessionId?: string
        voiceId?: string
        language?: string
        details?: Record<string, unknown>
    }): Promise<void> {
        await this.request('/api/voice/telemetry', {
            method: 'POST',
            body: JSON.stringify(event)
        })
    }

    /** Return the current auth token (for WebSocket query-param auth). */
    getAuthToken(): string | null {
        return this.getToken ? this.getToken() : this.token
    }

    async fetchVoiceBackend(): Promise<{ backend: string | null; backends: string[] }> {
        return await this.request('/api/voice/backend')
    }

    async fetchTranscriptionProviders(): Promise<{ providers: TranscriptionProviderInfo[] }> {
        return await this.request('/api/voice/transcription/providers')
    }

    async fetchTranscriptionCredentials(): Promise<TranscriptionCredentialStatus> {
        return await this.request('/api/voice/transcription/credentials')
    }

    async updateTranscriptionCredentials(
        update: TranscriptionCredentialsUpdate
    ): Promise<TranscriptionCredentialStatus> {
        return await this.request('/api/voice/transcription/credentials', {
            method: 'PUT',
            body: JSON.stringify(update),
        })
    }

    async transcribeVoice(options: {
        file: File
        provider: TranscriptionProvider
        mode: TranscriptionMode
        language?: string
    }): Promise<{ text: string; language?: string }> {
        const form = new FormData()
        form.set('file', options.file)
        form.set('provider', options.provider)
        form.set('mode', options.mode)
        if (options.language) form.set('language', options.language)
        return await this.request('/api/voice/transcription', { method: 'POST', body: form })
    }

    async fetchRealtimeTranscriptionToken(
        provider: 'openai' | 'elevenlabs' | 'deepgram',
        language?: string,
        signal?: AbortSignal
    ): Promise<{ token: string }> {
        return await this.request('/api/voice/transcription/realtime-token', {
            method: 'POST',
            signal,
            body: JSON.stringify({ provider, language })
        })
    }

    async fetchQwenToken(): Promise<{
        allowed: boolean
        wsUrl?: string
        error?: string
    }> {
        return await this.request('/api/voice/qwen-token', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async fetchGeminiToken(): Promise<{
        allowed: boolean
        apiKey?: string
        wsUrl?: string
        baseUrl?: string
        error?: string
    }> {
        return await this.request('/api/voice/gemini-token', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }
}
