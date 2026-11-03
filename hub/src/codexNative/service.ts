import { readFile, stat } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { settingsMatch as nativeModeSettingsMatch } from '@hapi/protocol/nativeSettings.server'
import type { CodexThreadCommand } from '@hapi/protocol/codexThreadCommands'
import { CodexGuardianDenials } from '@hapi/protocol/codexManagement'
import { messageInput, mentionSuggestions } from './mentions'
import { NativeConnection, record, text, type NativeEvent, type NativeRecord } from './transport'
import { listDaemonProjects, projectMemberships } from './projects'
import { nativeOutlinePage } from '../sync/conversationOutline'
import { nativeTurnContext } from './turnContext'
import { nativeItemLookup } from './itemLookup'
import { discoverThreadCommands, executeThreadCommand, NativeThreadCommandError } from './threadCommands'
import {
    createWorkspaceIdentityReader,
    desktopProjects,
    desktopExcludesThread,
    desktopHidesThread,
    desktopThreadSelection,
    needsDesktopIdentity,
    type DesktopProject,
    type WorkspaceIdentity,
} from './desktopSelection'

export type NativeConfig = {
    endpoint?: string
    namespace?: string
    token?: string
    desktopStatePath?: string
    desktopHostId?: string
}
export function nativeConfig(): NativeConfig {
    return {
        endpoint: process.env.HAPI_CODEX_NATIVE_SOCKET?.trim(),
        namespace: process.env.HAPI_CODEX_NATIVE_NAMESPACE,
        token: process.env.HAPI_CODEX_NATIVE_TOKEN,
        desktopStatePath: process.env.HAPI_CODEX_NATIVE_DESKTOP_STATE,
        desktopHostId: process.env.HAPI_CODEX_NATIVE_DESKTOP_HOST_ID,
    }
}
type Subscription = {
    client: NativeConnection
    users: number
    timer?: ReturnType<typeof setTimeout>
    attached: Promise<unknown>
    creating?: boolean
    empty?: boolean
    snapshot?: NativeRecord
    denials?: CodexGuardianDenials
}
function settingsSnapshot(value: NativeRecord): NativeRecord {
    return { ...value, effort: Object.hasOwn(value, 'effort') ? value.effort : value.reasoningEffort ?? null }
}
function settingsMatch(current: NativeRecord, patch: NativeRecord): boolean {
    return Object.entries(patch).every(([key, value]) => key === 'collaborationMode'
        && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? nativeModeSettingsMatch(record(current[key]), record(value))
        : isDeepStrictEqual(current[key], value))
}
export function fallbackThread(thread: NativeRecord): boolean {
    const source = thread.source
    return (
        thread.provenanceUnknown !== true &&
        thread.ephemeral !== true &&
        !thread.parentThreadId &&
        !thread.parent_thread_id &&
        (source === 'cli' || source === 'vscode') &&
        thread.threadSource !== 'agent_created_thread' &&
        thread.threadSource !== 'ambient_suggestions' &&
        !/exec|subagent/i.test(String(thread.originator ?? ''))
    )
}
export class NativeService {
    dispose(): void {
        for (const entry of this.subscriptions.values()) clearTimeout(entry.timer)
        this.subscriptions.clear()
        for (const client of [...this.connections])
            client.close('Native machine connection changed')
        this.connections.clear()
    }
    messageInput(threadId: string, message: string) {
        return messageInput(this, threadId, message)
    }
    suggestions(threadId: string, query: string) {
        return mentionSuggestions(this, threadId, query)
    }
    private subscriptions = new Map<string, Subscription>()
    private connections = new Set<NativeConnection>()
    private commandRuns = new Map<string, Promise<unknown>>()
    private identities = createWorkspaceIdentityReader()
    private daemonIdentities = createWorkspaceIdentityReader(async (path, args, timeout) => {
        const response = record(await this.call('command/exec', {
            command: ['git', ...args], cwd: path, timeoutMs: timeout,
            outputBytesCap: 16_384, sandboxPolicy: { type: 'readOnly', networkAccess: false },
        }, Date.now() + timeout))
        if (response.exitCode !== 0) throw new Error('Native Git identity unavailable')
        return text(response.stdout) ?? ''
    })
    constructor(
        readonly config: NativeConfig,
        private createConnection = () => new NativeConnection(config.endpoint!, config.token)
    ) {}
    private connection(): NativeConnection {
        if (this.connections.size >= 64) throw new Error('Native connection limit reached')
        const client = this.createConnection()
        this.connections.add(client)
        client.listeners.add((event) => {
            if (event.method === 'hapi/disconnected') this.connections.delete(client)
        })
        return client
    }
    authorized(namespace: string): boolean {
        return Boolean(
            this.config.endpoint &&
                this.config.namespace !== undefined &&
                namespace === this.config.namespace
        )
    }
    async call(method: string, params: unknown, deadline?: number): Promise<unknown> {
        if (deadline !== undefined)
            return this.withConnection((client) => client.request(method, params), deadline)
        const client = this.connection()
        try {
            return await client.request(method, params)
        } finally {
            client.close()
        }
    }
    async withConnection<T>(
        action: (client: NativeConnection) => Promise<T>,
        deadline?: number
    ): Promise<T> {
        if (deadline !== undefined && deadline <= Date.now())
            throw new Error('Native directory operation timed out')
        const client = this.connection()
        const timer =
            deadline === undefined
                ? undefined
                : setTimeout(
                      () => client.close('Native directory operation timed out'),
                      Math.max(1, deadline - Date.now())
                  )
        try {
            await client.connect()
            if (deadline !== undefined && deadline <= Date.now())
                throw new Error('Native directory operation timed out')
            return await action(client)
        } finally {
            clearTimeout(timer)
            client.close()
        }
    }
    async readThread(threadId: string): Promise<unknown> {
        try {
            return await this.call('thread/read', { threadId, includeTurns: false })
        } catch (error) {
            // A newly created empty thread may not have a rollout yet. Its creating
            // connection owns the live native metadata until first input is accepted.
            const live = this.subscriptions.get(threadId)
            if (live) return live.attached
            throw error
        }
    }
    async items(threadId: string, params: NativeRecord): Promise<unknown> {
        try {
            return await this.control(threadId, 'thread/items/list', params)
        } catch (error) {
            const empty = this.subscriptions.get(threadId)?.empty
            if (
                empty &&
                error instanceof Error &&
                /not materialized yet|not supported yet|no rollout found/.test(error.message)
            ) {
                return { data: [], nextCursor: null, backwardsCursor: null }
            }
            throw error
        }
    }
    outline(threadId: string, cursor: string | null, stopIds?: string[]) {
        return nativeOutlinePage((params) => this.control(threadId, 'thread/turns/list', params), cursor, stopIds)
    }
    turnContext(threadId: string, turnId: string, itemId: string) {
        return nativeTurnContext((params) => this.items(threadId, params), turnId, itemId)
    }

    item(threadId: string, turnId: string, itemId: string) {
        return nativeItemLookup(params => this.control(threadId, 'thread/items/read', params), turnId, itemId)
    }
    isCreatingEmpty(threadId: string): boolean {
        const entry = this.subscriptions.get(threadId)
        return entry?.creating === true && entry.empty === true
    }
    async startThread(
        params: NativeRecord,
        initial?: { text: string; clientId: string }
    ): Promise<NativeRecord> {
        if (this.subscriptions.size >= 32) throw new Error('Native subscription limit reached')
        const client = this.connection()
        try {
            const response = record(await client.request('thread/start', params))
            const threadId = text(record(response.thread).id)
            if (!threadId) throw new Error('Native thread creation returned no ID')
            const entry: Subscription = {
                client,
                users: 0,
                attached: Promise.resolve(response),
                creating: true,
                empty: true,
                snapshot: settingsSnapshot(response),
                denials: new CodexGuardianDenials(),
            }
            this.subscriptions.set(threadId, entry)
            client.listeners.add((event) => {
                const params = record(event.params)
                entry.denials?.observe(threadId, event.method, params)
                if (event.method === 'turn/started' && params.threadId === threadId)
                    entry.empty = false
                if (event.method === 'thread/settings/updated' && params.threadId === threadId) {
                    const settings = record(params.threadSettings)
                    entry.snapshot = { ...entry.snapshot, ...settings }
                    Object.assign(response, settings)
                }
                if (
                    event.method === 'hapi/disconnected' &&
                    this.subscriptions.get(threadId) === entry
                ) {
                    clearTimeout(entry.timer)
                    this.subscriptions.delete(threadId)
                }
            })
            entry.timer = setTimeout(() => {
                if (entry.users === 0 && this.subscriptions.get(threadId) === entry) {
                    this.subscriptions.delete(threadId)
                    client.close()
                }
            }, 60_000)
            entry.timer.unref()
            if (initial) {
                entry.empty = false
                try {
                    response.queued = await client.request('thread/queue/add', {
                        threadId,
                        clientUserMessageId: initial.clientId,
                        input: [{ type: 'text', text: initial.text, text_elements: [] }],
                    })
                } catch (error) {
                    response.initialMessageError =
                        error instanceof Error ? error.message : String(error)
                }
            }
            return response
        } catch (error) {
            client.close()
            throw error
        }
    }
    async desktop(deadline?: number): Promise<{
        state?: NativeRecord
        projects: DesktopProject[]
        membership: 'desktop' | 'fallback'
    }> {
        const { desktopStatePath, desktopHostId } = this.config
        if (!desktopStatePath || !desktopHostId) return { projects: [], membership: 'fallback' }
        try {
            if ((await stat(desktopStatePath)).size > 8 * 1024 * 1024)
                throw new Error('Desktop state too large')
            const signal =
                deadline === undefined
                    ? undefined
                    : AbortSignal.timeout(Math.max(1, deadline - Date.now()))
            const state = record(
                JSON.parse(await readFile(desktopStatePath, { encoding: 'utf8', signal }))
            )
            return { state, projects: desktopProjects(state, desktopHostId), membership: 'desktop' }
        } catch {
            return { projects: [], membership: 'fallback' }
        }
    }
    async catalog(params: {
        cursor?: string
        limit: number
        projectId?: string
        catalog?: string
        parentThreadId?: string
        deadline?: number
    }): Promise<NativeRecord> {
        const deadline = params.deadline ?? Date.now() + 5000
        const checkBudget = () => {
            if (Date.now() >= deadline) throw new Error('Native directory operation timed out')
        }
        checkBudget()
        const background = params.catalog === 'background'
        const canonicalProjects = listDaemonProjects(this, deadline).catch(() => [])
        const page = record(
            await this.call(
                'thread/list',
                {
                    cursor: params.cursor,
                    limit: params.limit,
                    archived: false,
                    sourceKinds: background
                        ? [
                              'cli',
                              'vscode',
                              'exec',
                              'appServer',
                              'subAgent',
                              'subAgentReview',
                              'subAgentCompact',
                              'subAgentThreadSpawn',
                              'subAgentOther',
                              'unknown',
                          ]
                        : ['cli', 'vscode'],
                    parentThreadId: params.parentThreadId,
                    useStateDbOnly: true,
                    sortKey: 'updated_at',
                },
                deadline
            )
        )
        checkBudget()
        const desktop = await this.desktop(deadline)
        checkBudget()
        const threads = Array.isArray(page.data) ? page.data.map(record) : []
        // Empty newly-started threads are not in app-server's durable catalog until
        // their first input. Keep its authoritative start response while HAPI owns
        // the creating connection so changing launch/workspace modes is visible.
        if (!params.cursor) {
            const creating = await Promise.all([...this.subscriptions.values()].filter(entry => entry.creating && entry.empty).map(async entry => {
                try { return record(record(await entry.attached).thread) } catch { return {} }
            }))
            for (const thread of creating) {
                if (text(thread.id) && !threads.some(existing => existing.id === thread.id)) threads.unshift(thread)
            }
        }
        // State-db catalog rows omit provenance on some daemon versions. Resolve only this
        // page, four requests at a time, without loading any conversation items.
        if (desktop.membership === 'fallback' || background) {
            await this.withConnection(async (client) => {
                for (let offset = 0; offset < threads.length; offset += 4) {
                    checkBudget()
                    await Promise.all(
                        threads.slice(offset, offset + 4).map(async (thread, index) => {
                            if (thread.source !== 'cli' && thread.source !== 'vscode') return
                            try {
                                const details = record(
                                    record(
                                        await client.request('thread/read', {
                                            threadId: thread.id,
                                            includeTurns: false,
                                        })
                                    ).thread
                                )
                                threads[offset + index] = { ...thread, ...details }
                            } catch {
                                threads[offset + index] = { ...thread, provenanceUnknown: true }
                            }
                        })
                    )
                }
                checkBudget()
            }, deadline)
        }
        let selected = new Map<string, DesktopProject>()
        const windowsDesktop = this.config.desktopHostId === 'local' && !this.config.endpoint?.startsWith('unix://')
        if (desktop.state) {
            selected = desktopThreadSelection(desktop.state, this.config.desktopHostId!, threads)
            const unresolved = windowsDesktop ? threads.filter((thread) =>
                !selected.has(String(thread.id)) && needsDesktopIdentity(desktop.state, thread)
            ) : threads
            const paths = [
                ...new Set([
                    ...(unresolved.length ? desktop.projects.flatMap((p) => p.rootPaths ?? [p.path]) : []),
                    ...unresolved.map((t) => text(t.cwd)).filter((p): p is string => Boolean(p)),
                ]),
            ].slice(0, 512)
            const identities = new Map<string, WorkspaceIdentity>()
            for (
                let offset = 0;
                (this.config.endpoint?.startsWith('unix://') || this.config.desktopHostId === 'local') && offset < paths.length;
                offset += 4
            ) {
                if (windowsDesktop && Date.now() >= deadline) break
                checkBudget()
                const results = await Promise.allSettled(
                    paths.slice(offset, offset + 4).map(async (path) => {
                        const reader = this.config.endpoint?.startsWith('unix://') ? this.identities : this.daemonIdentities
                        identities.set(path, await reader(path, deadline))
                    })
                )
                if (!windowsDesktop)
                    for (const result of results) if (result.status === 'rejected') throw result.reason
            }
            selected = desktopThreadSelection(
                desktop.state,
                this.config.desktopHostId!,
                threads,
                identities
            )
        }
        if (!windowsDesktop || !desktop.state) checkBudget()
        const canonical = projectMemberships(await canonicalProjects, desktop, this.config.desktopHostId)
        const isHapiThread = (thread: NativeRecord) => thread.originator === 'hapi-native' && thread.threadSource === 'user'
            && thread.ephemeral !== true && !thread.parentThreadId && !thread.parent_thread_id
            && !desktopHidesThread(desktop.state, thread)
        for (const thread of threads) {
            if (isHapiThread(thread) && !text(thread.projectId)) selected.delete(String(thread.id))
            const project = canonical.get(String(thread.projectId))
            if (project && !desktopExcludesThread(desktop.state, thread) && (fallbackThread(thread) || isHapiThread(thread))) selected.set(String(thread.id), project)
        }
        const projects = [...new Map([...desktop.projects, ...canonical.values()].map(project => [project.id, project])).values()]
        const data = threads
            .filter((thread) => {
                const membership = selected.get(String(thread.id))
                const ordinary =
                    desktop.membership === 'desktop' ? Boolean(membership) || isHapiThread(thread) : fallbackThread(thread) || isHapiThread(thread)
                if (background)
                    return (
                        !membership &&
                        !isHapiThread(thread) &&
                        (Boolean(thread.parentThreadId) ||
                            Boolean(thread.parent_thread_id) ||
                            (thread.source !== 'cli' && thread.source !== 'vscode') ||
                            thread.threadSource === 'agent_created_thread')
                    )
                return ordinary && (!params.projectId || membership?.id === params.projectId || thread.projectId === params.projectId)
            })
            .map((thread) => ({
                ...thread,
                desktopProjectId: selected.get(String(thread.id))?.id ?? null,
                desktopProject: selected.get(String(thread.id)) ?? null,
            }))
        return { ...page, data, projects, membership: desktop.membership }
    }
    private acquire(threadId: string): Subscription {
        let entry = this.subscriptions.get(threadId)
        if (!entry) {
            if (this.subscriptions.size >= 32) throw new Error('Native subscription limit reached')
            const client = this.connection()
            entry = {
                client,
                users: 0,
                attached: client.request('thread/resume', { threadId, excludeTurns: true }),
            }
            const current = entry
            current.denials = new CodexGuardianDenials()
            void current.attached.then(state => {
                current.snapshot ??= settingsSnapshot(record(state))
            }).catch(() => {})
            client.listeners.add((event) => {
                const params = record(event.params)
                current.denials?.observe(threadId, event.method, params)
                if (event.method === 'thread/settings/updated' && params.threadId === threadId) {
                    current.snapshot = { ...current.snapshot, ...record(params.threadSettings) }
                }
                if (
                    event.method === 'hapi/disconnected' &&
                    this.subscriptions.get(threadId) === current
                ) {
                    clearTimeout(current.timer)
                    this.subscriptions.delete(threadId)
                }
            })
            void entry.attached.catch(() => {
                if (this.subscriptions.get(threadId) === current)
                    this.subscriptions.delete(threadId)
                client.close()
            })
            this.subscriptions.set(threadId, entry)
        }
        clearTimeout(entry.timer)
        entry.users++
        return entry
    }
    async subscribe(threadId: string, listener: (event: NativeEvent) => void): Promise<() => void> {
        const entry = this.acquire(threadId)
        const filtered = (event: NativeEvent) => {
            const params = record(event.params),
                requestParams = record(params.params)
            const target =
                text(params.threadId) ??
                text(record(params.thread).id) ??
                text(requestParams.threadId)
            if (
                event.method === 'hapi/disconnected' ||
                target === threadId ||
                (event.method === 'hapi/requestResolved' && !target)
            )
                listener(event)
        }
        entry.client.listeners.add(filtered)
        try {
            const state = await entry.attached
            listener({
                method: 'hapi/ready',
                params: {
                    ...record(state),
                    // The attach response is retained for the subscription lifetime.
                    // Other clients may have changed settings since it resolved.
                    threadSettings: entry.snapshot ?? settingsSnapshot(record(state)),
                    requests: [...entry.client.requests.values()].filter(
                        (r) => record(r.params).threadId === threadId
                    ),
                },
            })
        } catch (error) {
            entry.client.listeners.delete(filtered)
            this.release(threadId, entry)
            throw error
        }
        let released = false
        return () => {
            if (released) return
            released = true
            entry.client.listeners.delete(filtered)
            this.release(threadId, entry)
        }
    }
    private release(threadId: string, entry: Subscription): void {
        entry.users--
        if (entry.users > 0) return
        entry.timer = setTimeout(() => {
            if (entry.users === 0) {
                if (this.subscriptions.get(threadId) === entry) this.subscriptions.delete(threadId)
                entry.client.close()
            }
        }, 5000)
        entry.timer.unref()
    }
    async control(threadId: string, method: string, params: NativeRecord): Promise<unknown> {
        // Controls use a separate connection and never wait for the subscription or history page.
        return this.call(method, { ...params, threadId })
    }
    guardianDenial(threadId: string) {
        return this.subscriptions.get(threadId)?.denials?.show() ?? null
    }
    async retryGuardianDenial(threadId: string, reviewId: string): Promise<void> {
        const entry = this.subscriptions.get(threadId)
        if (entry?.snapshot?.approvalsReviewer !== 'auto_review') {
            throw new NativeThreadCommandError(409, 'Automatic review must be active to retry a denied action')
        }
        const event = entry.denials?.claim(reviewId)
        if (!event) throw new NativeThreadCommandError(409, 'This native denial is no longer available for a one-time retry')
        try {
            await this.control(threadId, 'thread/approveGuardianDeniedAction', { event })
        } catch (error) {
            throw new NativeThreadCommandError(502,
                `Native retry was not confirmed; check the conversation before another attempt: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    async threadCommandState(threadId: string) {
        const entry = this.subscriptions.get(threadId)
        let snapshot: NativeRecord | null = null
        if (entry) {
            try {
                const attached = await entry.attached
                snapshot = entry.snapshot ?? settingsSnapshot(record(attached))
            } catch { /* A read never attaches or resumes a thread just to discover settings. */ }
        }
        const state = await this.withConnection(client => discoverThreadCommands(
            (method, params) => client.request(method, params), threadId, snapshot
        ))
        const current = this.subscriptions.get(threadId)
        const latest = current?.snapshot ?? (current === entry ? snapshot : null)
        state.collaborationMode = latest?.collaborationMode && typeof latest.collaborationMode === 'object'
            ? record(latest.collaborationMode) : null
        return state
    }
    async threadCommand(threadId: string, command: CodexThreadCommand, submission?: { input: NativeRecord[]; clientId: string }) {
        // Serialize control RPCs only. Submitted input remains in the daemon's queue.
        const previous = this.commandRuns.get(threadId) ?? Promise.resolve()
        const running = previous.catch(() => {}).then(() => executeThreadCommand(this, threadId, command, submission))
        this.commandRuns.set(threadId, running)
        try {
            return await running
        } finally {
            if (this.commandRuns.get(threadId) === running) this.commandRuns.delete(threadId)
        }
    }
    async settings(threadId: string, update: NativeRecord | ((current: NativeRecord) => NativeRecord)): Promise<NativeRecord> {
        const creating = this.subscriptions.get(threadId)
        const borrowed = creating?.creating === true
        const client = borrowed ? creating.client : this.connection()
        let timer: ReturnType<typeof setTimeout> | undefined
        let listener: ((event: NativeEvent) => void) | undefined
        try {
            const resumed = record(
                await (borrowed
                    ? creating.attached
                    : client.request('thread/resume', { threadId, excludeTurns: true }))
            )
            const current = settingsSnapshot(resumed)
            const patch = { ...(typeof update === 'function' ? update(current) : update) }
            if (typeof patch.model === 'string' && patch.model !== current.model &&
                !Object.hasOwn(patch, 'effort') && typeof current.effort === 'string') {
                // A browser may have an old effort from another device. Migrate
                // only an incompatible current daemon effort, never its UI copy.
                let cursor: string | undefined
                do {
                    const page = record(await client.request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) }))
                    const model = (Array.isArray(page.data) ? page.data : []).map(record)
                        .find(model => model.id === patch.model || model.model === patch.model)
                    if (model) {
                        const efforts = Array.isArray(model.supportedReasoningEfforts)
                            ? model.supportedReasoningEfforts.map(value => record(value).reasoningEffort) : []
                        if (efforts.length && !efforts.includes(current.effort) && typeof model.defaultReasoningEffort === 'string')
                            patch.effort = model.defaultReasoningEffort
                        break
                    }
                    const next = text(page.nextCursor)
                    if (next === cursor) break
                    cursor = next
                } while (cursor)
            }
            if (settingsMatch(current, patch))
                return { applied: current }
            const applied = new Promise<NativeRecord>((resolve, reject) => {
                listener = (event) => {
                    const params = record(event.params),
                        settings = record(params.threadSettings)
                    if (
                        event.method === 'thread/settings/updated' &&
                        params.threadId === threadId &&
                        settingsMatch(settings, patch)
                    )
                        resolve(settings)
                    if (event.method === 'hapi/disconnected')
                        reject(new Error('Native settings confirmation disconnected'))
                }
                client.listeners.add(listener)
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                'Native settings update is not confirmed; refresh before retrying'
                            )
                        ),
                    15_000
                )
            })
            void applied.catch(() => {})
            await client.request('thread/settings/update', { ...patch, threadId })
            const confirmed = await applied
            return { applied: confirmed }
        } finally {
            clearTimeout(timer)
            if (listener) client.listeners.delete(listener)
            if (!borrowed) client.close()
        }
    }
    reply(threadId: string, id: string, response: { result?: unknown; error?: unknown }): void {
        const entry = this.subscriptions.get(threadId)
        if (!entry) throw new Error('Open the native thread to answer its pending request')
        entry.client.reply(id, threadId, response)
    }
}
