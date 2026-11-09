import React from 'react'
import { RPC_METHODS, SessionConfigOptionRequestSchema, type SessionConfigOption } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { createDshBackend } from './utils/dshBackend'
import { prepareDshPermissionBridge } from './utils/permissionBridge'
import type { DshSession } from './session'
import type { DshMode } from './types'
import type { QueueReservation } from '@/utils/MessageQueue2'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { DSH_STEERING_CAPABILITY, DSH_STEERING_METHOD, hasDshSteeringCapability, isDshSteerReceipt } from './utils/steering'
import { listProviderSlashCommands } from '@/modules/common/slashCommands'
import { hasQueuedSkill } from '@/utils/queuedSkillReference'

type ReasoningPreference = { model: string | null; values: Record<string, string> }

export class DshRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createDshBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private currentBackendModel: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    private selectedConfigs: Record<string, string> = {}
    private initialConfigs: Record<string, string> = {}
    private selectedReasoning?: ReasoningPreference
    private initialReasoning?: ReasoningPreference
    private configsReady = false
    private switchingModel = false
    private cleanupBridge: (() => Promise<void>) | null = null
    private running: Promise<RemoteLauncherExitReason> | null = null
    private disconnecting: Promise<void> | null = null
    private promptInFlight = false
    private activePromptModeHash: string | null = null
    private steerEpoch = 0
    private unregisterQueuedSteer: (() => void) | null = null
    private readonly steerRequests = new Set<Promise<unknown>>()
    private readonly steerInvokedAt = new WeakMap<QueueReservation<DshMode>, number>()
    private readonly nativeCommands = new Set<string>()
    private readonly nativeCommandDescriptions = new Map<string, string>()

    private publishSteeringActive(active: boolean): void {
        this.session.client.updateAgentState?.(state => ({ ...state, steeringActive: active }))
    }

    private effectiveModeHash(requested?: DshMode): string {
        const model = this.resolveModel(requested?.model)
        const configOptions = Object.fromEntries(this.runtimeOptions()
            .filter(option => option.currentValue !== undefined)
            .map(option => [option.id, option.currentValue!]))
        // Before discovery, ordinary messages omit preferences and use the
        // initial presets. Compare those actual values with later snapshots.
        if (requested) Object.assign(configOptions, this.queuedConfigOptions(requested, model))
        return this.session.queue.modeHasher({ ...(model ? { model } : {}), configOptions })
    }

    private async steerQueuedMessage(payload: unknown): Promise<{ steered: boolean; error?: string }> {
        const localId = typeof (payload as { localId?: unknown } | null)?.localId === 'string'
            ? (payload as { localId: string }).localId : ''
        const backend = this.backend
        const sessionId = this.session.sessionId
        if (!localId) return { steered: false, error: 'Missing localId' }
        if (!backend || !sessionId || !this.promptInFlight || this.shouldExit
            || !hasDshSteeringCapability(backend.getAgentExtensionCapability(DSH_STEERING_CAPABILITY))) {
            return { steered: false, error: 'No active steerable DSH turn' }
        }
        const generation = backend.getPromptGeneration()
        const epoch = this.steerEpoch
        const queue = this.session.queue
        const taken = queue.takeByLocalId(localId)
        if (!taken) return { steered: false, error: 'Message not in queue' }
        if (taken.item.isolate || this.effectiveModeHash(taken.item.mode) !== this.activePromptModeHash) {
            queue.restoreReservation(taken)
            return { steered: false, error: 'Queued message mode differs from the active turn' }
        }
        if (!queue.beginReservationDispatch(taken)) return { steered: false, error: 'Steer cancelled' }
        const hold = () => {
            queue.markReservationIndeterminate(taken)
            this.session.client.emitSteerIndeterminate([localId])
        }
        if (!await this.session.client.setSteerDeliveryState([localId], 'dispatching')) {
            hold()
            return { steered: false, error: 'Steer state is indeterminate' }
        }
        const restore = async () => {
            if (!taken.originIndeterminate && !await this.session.client.setSteerDeliveryState([localId], 'queued')) {
                hold()
                return
            }
            queue.restoreReservation(taken)
        }
        if (taken.state !== 'dispatching' || !this.promptInFlight || this.shouldExit || this.steerEpoch !== epoch
            || this.backend !== backend || this.session.sessionId !== sessionId || backend.getPromptGeneration() !== generation) {
            await restore()
            return { steered: false, error: 'Active turn changed' }
        }
        try {
            // Keep the dispatch chronology even when output arrives before this
            // async receipt continuation, or an indeterminate request is retried.
            const invokedAt = this.steerInvokedAt.get(taken) ?? Date.now()
            this.steerInvokedAt.set(taken, invokedAt)
            const result = await backend.sendExtensionRequest(DSH_STEERING_METHOD,
                { sessionId, requestId: localId, text: taken.item.message }, { timeoutMs: 10_000 })
            if (!isDshSteerReceipt(result, localId)) {
                hold()
                return { steered: false, error: 'DSH steering acknowledgement is indeterminate' }
            }
            queue.commitReservation(taken)
            this.messageBuffer.addMessage(taken.item.message, 'user')
            this.session.client.emitMessagesConsumed([localId], { steered: true, invokedAt })
            return { steered: true }
        } catch (error) {
            if (isAcpIndeterminateError(error)) {
                hold()
                return { steered: false, error: 'DSH steering outcome is indeterminate' }
            }
            await restore()
            return { steered: false, error: error instanceof Error ? error.message : 'DSH steering failed' }
        }
    }

    private disconnectBackend(): Promise<void> {
        if (!this.backend) return Promise.resolve()
        return this.disconnecting ??= this.backend.disconnect()
    }

    getConfigPreferences(): Record<string, string> | undefined {
        if (!this.configsReady) return undefined
        const model = this.resolveModel(this.opts.getPreferredModel?.())
        return { ...this.selectedConfigs, ...this.reasoningValues(this.selectedReasoning, model) }
    }

    refreshConfigOptions(): void {
        if (this.configsReady) this.publishConfigOptions()
    }

    private resolveModel(preference?: string | null): string | null {
        return preference === null ? this.initialBackendModel : preference ?? this.currentBackendModel
    }

    private reasoningValues(preference: ReasoningPreference | undefined, model: string | null): Record<string, string> | undefined {
        return preference?.model === model ? preference.values : undefined
    }

    private queuedConfigOptions(mode: DshMode, model: string | null): Record<string, string> {
        return mode.configOptions ?? { ...this.initialConfigs, ...this.reasoningValues(this.initialReasoning, model) }
    }

    private runtimeOptions(): SessionConfigOption[] {
        if (!this.backend || !this.session.sessionId) return []
        return (this.backend.getSessionConfigOptions(this.session.sessionId) ?? [])
            .filter(option => option.category === 'permission' || option.category === 'thought_level')
            .map(option => option.category === 'thought_level' ? { ...option, category: 'reasoning' } : option)
    }

    private visibleOptions(options = this.runtimeOptions()): SessionConfigOption[] {
        const sameModel = this.resolveModel(this.opts.getPreferredModel?.()) === this.currentBackendModel
        return options.filter(option => sameModel || option.category !== 'reasoning')
    }

    private publishConfigOptions(): void {
        const reasoning = this.reasoningValues(this.selectedReasoning, this.currentBackendModel)
        const runtime = this.runtimeOptions()
        for (const selections of [this.selectedConfigs, reasoning]) {
            for (const [id, value] of Object.entries(selections ?? {})) {
                if (!runtime.find(option => option.id === id)?.options.some(choice => choice.value === value)) {
                    delete selections?.[id]
                }
            }
        }
        const options = this.visibleOptions(runtime).map(option => {
            const selectedValue = (option.category === 'reasoning' ? reasoning : this.selectedConfigs)?.[option.id]
            return { ...option, ...(selectedValue !== undefined ? { selectedValue } : {}) }
        })
        this.session.client.updateMetadata(metadata => ({ ...metadata, sessionConfigOptions: options }))
    }

    constructor(
        private readonly session: DshSession,
        private readonly opts: {
            /** Spawn-time model override (opaque ACP config-option value). */
            model?: string
            resumeSessionId?: string
            preferredOptions?: SessionConfigOption[]
            getPreferredModel?: () => string | null | undefined
            onModelRollback?: (model: string | null) => void
            onConfigDiscovered?: (model: string | null) => void
        } = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        this.running = this.start({ onExit: () => this.handleExitFromUi() })
        return this.running
    }

    async kill(): Promise<void> {
        await this.requestExit('exit', async () => {
            this.abortController.abort()
            this.steerEpoch++
            this.publishSteeringActive(false)
            // Ending the session must also stop an unresponsive initialize,
            // session/new or prompt; cooperative session/cancel cannot do that.
            await this.disconnectBackend()
            await this.permissionHandler?.cancelAll('Session ended')
            this.session.onThinkingChange(false)
        })
        // Let start()'s finally close ACP and remove its temporary plugin before
        // the runner lifecycle exits the process, including during initialization.
        await this.running?.catch(() => {})
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'DeepSeek Harness'
        })
    }

    protected async runMainLoop(): Promise<void> {
        const bridge = await prepareDshPermissionBridge()
        this.cleanupBridge = bridge.cleanup
        if (this.shouldExit) return
        const backend = createDshBackend(process.env, bridge.args)
        this.backend = backend
        this.publishSteeringActive(false)
        this.session.client.updateMetadata(metadata => ({ ...metadata, capabilities: { ...metadata.capabilities, steering: false } }))
        backend.onStderrError((error) => {
            logger.debug('[dsh-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        // Register the catalog RPC before initialization: a client that opens
        // the model picker while initialize/session/new is still pending
        // would otherwise hit an unregistered-method rejection, and the
        // picker has no retry path — it would stay empty until remounted.
        // The handler parks on readiness and answers once the session exists
        // and model discovery has settled.
        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        void ready.catch(() => {})
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListSlashCommands, async () => {
            await ready
            return { success: true, commands: await listProviderSlashCommands('dsh', this.session.path,
                [...this.nativeCommands].map(name => ({ name, description: this.nativeCommandDescriptions.get(name) }))) }
        })
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfigOption, async (raw: unknown) => {
            await ready
            const { configId, value } = SessionConfigOptionRequestSchema.parse(raw)
            const option = this.visibleOptions().find(option => option.id === configId)
            if (!option?.options.some(choice => choice.value === value)) throw new Error('This DSH configuration value is not currently advertised')
            if (option.category === 'reasoning') {
                const model = this.currentBackendModel
                this.selectedReasoning = { model, values: { ...this.reasoningValues(this.selectedReasoning, model), [configId]: value } }
            } else {
                this.selectedConfigs[configId] = value
            }
            this.publishConfigOptions()
            return { applied: { configId, value }, applyAt: 'next-message' }
        })
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListDshModels, async () => {
            let acpSessionId: string
            try {
                acpSessionId = await ready
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `DSH session is not available: ${message}` }
            }
            const metadata = backend.getSessionModelsMetadata(acpSessionId)
            if (!metadata) {
                return { success: false, error: 'DSH model metadata is not available' }
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: this.currentBackendModel ?? metadata.currentModelId
            }
        })

        let acpSessionId: string
        try {
            await backend.initialize()
            const supported = hasDshSteeringCapability(backend.getAgentExtensionCapability(DSH_STEERING_CAPABILITY))
            this.session.client.updateMetadata(metadata => ({ ...metadata, capabilities: { ...metadata.capabilities, steering: supported } }))
            if (this.shouldExit) {
                markFailed(new Error('DSH session ended during initialization'))
                return
            }
            const config = {
                cwd: this.session.path,
                // HAPI leaves tools to the DSH composition and adds no MCP servers.
                mcpServers: []
            }
            acpSessionId = this.opts.resumeSessionId
                ? await backend.resumeSession({ ...config, sessionId: this.opts.resumeSessionId })
                : await backend.newSession(config)
            this.session.sessionId = acpSessionId
            const commandCapability = backend.getAgentExtensionCapability('hapi.dshCommands') as { version?: unknown; method?: unknown } | undefined
            if (commandCapability?.version === 1 && commandCapability.method === '_hapi/dsh/command') {
                const catalog = await backend.sendExtensionRequest<{ commands?: Array<{ name?: unknown; description?: unknown }> }>('_hapi/dsh/command',
                    { sessionId: acpSessionId, operation: 'list' }, { timeoutMs: 10_000 })
                for (const command of catalog.commands ?? []) {
                    if (typeof command.name === 'string') {
                        this.nativeCommands.add(command.name)
                        if (typeof command.description === 'string') this.nativeCommandDescriptions.set(command.name, command.description)
                    }
                }
            }
            this.session.client.updateMetadata(metadata => ({ ...metadata, slashCommands: [...this.nativeCommands] }))
        } catch (error) {
            markFailed(error)
            if (this.shouldExit) return
            throw error
        }

        const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
        // Capture the server default BEFORE applying any override: an explicit
        // "Default" reset later in the session (queued as model: null) switches
        // back to this value; without it the reset would silently keep the
        // last explicitly-applied model.
        this.initialBackendModel = modelOption?.currentValue
            ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
            ?? null
        if (this.opts.model && this.opts.model !== this.initialBackendModel && modelOption) {
            this.currentBackendModel = await this.applyModelSwitch(backend, acpSessionId, this.opts.model)
        }
        if (this.opts.resumeSessionId && this.opts.model && this.opts.model !== this.initialBackendModel
            && (this.currentBackendModel !== this.opts.model
                || backend.getConfigOptionByCategory(acpSessionId, 'model')?.currentValue !== this.opts.model)) {
            const error = new Error('DeepSeek Harness could not restore the selected model')
            markFailed(error)
            throw error
        }
        if (!this.currentBackendModel) {
            this.currentBackendModel = this.initialBackendModel
        }
        this.opts.onConfigDiscovered?.(this.currentBackendModel)
        const runtime = this.runtimeOptions()
        for (const option of runtime) {
            if (option.category === 'permission' && option.currentValue !== undefined && option.options.some(choice => choice.value === option.currentValue)) {
                this.initialConfigs[option.id] = option.currentValue
            }
        }
        this.selectedConfigs = { ...this.initialConfigs }
        for (const option of this.opts.preferredOptions ?? []) {
            if (option.category === 'permission' && option.selectedValue !== undefined) {
                const advertised = runtime.find(entry => entry.id === option.id && entry.category === 'permission')
                if (!advertised?.options.some(entry => entry.value === option.selectedValue)) {
                    const error = new Error('DeepSeek Harness could not restore the selected permission preset')
                    markFailed(error)
                    throw error
                }
                this.selectedConfigs[option.id] = option.selectedValue
            } else if (option.category === 'reasoning' && option.selectedValue !== undefined && this.currentBackendModel === this.initialBackendModel
                && runtime.some(entry => entry.category === 'reasoning' && entry.id === option.id && entry.options.some(choice => choice.value === option.selectedValue))) {
                this.selectedReasoning ??= { model: this.currentBackendModel, values: {} }
                this.selectedReasoning.values[option.id] = option.selectedValue
            }
        }
        this.configsReady = true
        backend.onSessionConfigOptionsUpdate(() => {
            if (!this.switchingModel) this.publishConfigOptions()
        })
        this.publishConfigOptions()
        // Messages may have arrived before discovery. Apply the preferences
        // already selected on the existing HAPI session to those batches too.
        this.initialConfigs = { ...this.selectedConfigs }
        this.initialReasoning = this.selectedReasoning && { ...this.selectedReasoning, values: { ...this.selectedReasoning.values } }
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        markReady(acpSessionId)
        if (this.opts.resumeSessionId || backend.supportsResumeSession()) this.session.onSessionFound(acpSessionId)

        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => undefined
        )
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })
        const steerHandler = (payload: unknown) => {
            const pending = this.steerQueuedMessage(payload)
            this.steerRequests.add(pending)
            void pending.finally(() => this.steerRequests.delete(pending)).catch(() => {})
            return pending
        }
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, steerHandler)
        this.unregisterQueuedSteer = this.session.registerQueuedSteerHandler(steerHandler)
        this.session.client.emitSessionReady()

        while (!this.shouldExit) {
            const batch = await this.session.queue.waitForMessagesAndGetAsString(this.abortController.signal)
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) continue
                break
            }

            const requestedModel = batch.mode.model
            const requestedRuntimeModel = this.resolveModel(requestedModel)
            if (requestedModel === null) {
                // Explicit "Default": switch back to the server default captured
                // at session creation. The web picker resets the session model
                // to null and the next queued turn carries it here.
                if (this.initialBackendModel && this.initialBackendModel !== this.currentBackendModel) {
                    const applied = await this.applyModelSwitch(backend, acpSessionId, this.initialBackendModel)
                    if (applied) {
                        batch.mode.model = applied
                    } else {
                        batch.mode.model = this.currentBackendModel ?? undefined
                        this.opts.onModelRollback?.(this.currentBackendModel)
                    }
                } else if (!this.initialBackendModel) {
                    // Nothing captured to go back to — keep the running model and
                    // report it back so the picker does not claim "Default".
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Cannot reset the DSH model: the agent did not report a default model.'
                    })
                } else {
                    // Already running the default.
                    batch.mode.model = this.currentBackendModel ?? undefined
                }
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                const applied = await this.applyModelSwitch(backend, acpSessionId, requestedModel)
                if (applied) {
                    batch.mode.model = applied
                } else {
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                }
            }

            let configFailed = false
            for (const [configId, value] of Object.entries(this.queuedConfigOptions(batch.mode, requestedRuntimeModel))) {
                const option = this.runtimeOptions().find(option => option.id === configId)
                const label = option?.name ?? configId
                try {
                    if (!option?.options.some(choice => choice.value === value)
                        || (option.category === 'reasoning' && requestedRuntimeModel !== this.currentBackendModel)) {
                        throw new Error('The selected value is no longer available')
                    }
                    if (option.currentValue === value) continue
                    await backend.setConfigOption(acpSessionId, configId, value)
                    if (this.runtimeOptions().find(option => option.id === configId)?.currentValue !== value) {
                        throw new Error('DSH did not confirm the selected value')
                    }
                } catch (error) {
                    configFailed = true
                    const selections = option?.category === 'reasoning'
                        ? this.reasoningValues(this.selectedReasoning, requestedRuntimeModel) : this.selectedConfigs
                    if (selections?.[configId] === value) delete selections[configId]
                    this.publishConfigOptions()
                    this.session.sendSessionEvent({ type: 'message', message: `DSH setting ${label} failed; this message was not sent: ${error instanceof Error ? error.message : String(error)}` })
                    break
                }
            }
            if (configFailed) {
                if (this.session.queue.size() === 0 && !this.shouldExit) this.session.sendSessionEvent({ type: 'ready' })
                continue
            }

            const commandName = /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(batch.message.trim())?.[1]
            if (commandName && !batch.mode.customSlash && (this.nativeCommands.has(commandName) || commandName === 'compact')) {
                if (!this.nativeCommands.has(commandName)) {
                    this.session.sendSessionEvent({ type: 'message', message: `/${commandName} is not supported by this DSH ACP server. The command was not sent to the model.` })
                    if (this.session.queue.size() === 0 && !this.shouldExit) this.session.sendSessionEvent({ type: 'ready' })
                    continue
                }
                this.session.onThinkingChange(true)
                try {
                    const execution = await backend.sendExtensionRequest<{ result?: { kind?: string; text?: string } }>('_hapi/dsh/command',
                        { sessionId: acpSessionId, operation: 'execute', text: batch.message.trim() }, { timeoutMs: 600_000 })
                    this.session.sendSessionEvent({ type: 'message', message: execution.result?.text ?? 'DSH native command finished without a text result.' })
                } catch (error) {
                    this.session.sendSessionEvent({ type: 'message', message: `DSH native command failed: ${error instanceof Error ? error.message : String(error)}` })
                } finally {
                    this.session.onThinkingChange(false)
                    if (this.session.queue.size() === 0 && !this.shouldExit) this.session.sendSessionEvent({ type: 'ready' })
                }
                continue
            }

            // DSH expands /skill in the ACP prompt. Resolve after native command
            // dispatch so an explicitly selected skill cannot become a command.
            const skill = batch.mode.skillReference
            const text = skill && await hasQueuedSkill(skill, this.session.path, 'dsh')
                ? `${batch.message.slice(0, skill.offset)}/${batch.message.slice(skill.offset + 1)}`
                : batch.message
            if (this.shouldExit || this.abortController.signal.aborted) break
            this.session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            const prompt: PromptContent[] = [{ type: 'text', text }]
            try {
                this.promptInFlight = true
                this.activePromptModeHash = this.effectiveModeHash()
                const pending = backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
                this.publishSteeringActive(hasDshSteeringCapability(backend.getAgentExtensionCapability(DSH_STEERING_CAPABILITY)))
                await pending
            } catch (error) {
                if (this.shouldExit) break
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[dsh-acp] prompt failed', { message })
                this.session.sendSessionEvent({ type: 'message', message: `DSH prompt failed: ${message}` })
                this.messageBuffer.addMessage(`DSH prompt failed: ${message}`, 'status')
            } finally {
                this.promptInFlight = false
                this.activePromptModeHash = null
                this.publishSteeringActive(false)
                await Promise.allSettled([...this.steerRequests])
                this.session.onThinkingChange(false)
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (this.session.queue.size() === 0 && !this.shouldExit) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.steerEpoch++
        this.promptInFlight = false
        this.publishSteeringActive(false)
        this.unregisterQueuedSteer?.()
        this.unregisterQueuedSteer = null
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.permissionHandler?.cancelAll('Session ended')
        this.permissionHandler = null
        try {
            await this.disconnectBackend()
        } finally {
            this.backend = null
            await this.cleanupBridge?.()
            this.cleanupBridge = null
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant')
                break
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant')
                break
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status')
                break
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status')
                break
            case 'usage':
            case 'reasoning':
            case 'tool_call':
            case 'tool_result':
            case 'plan':
                break
            default: {
                const _exhaustive: never = message
                return _exhaustive
            }
        }
    }

    /**
     * Switch the DSH model through `session/set_config_option` — dsh does not
     * implement `session/set_model` (verified against 0.2.0-rc.2: -32601).
     * Model ids are opaque config-option values (JSON provider+model tuples)
     * and are sent back verbatim; unknown ids fail loud with -32602.
     * Returns the applied model, or null when the switch failed (caller keeps
     * the previous model).
     */
    private async applyModelSwitch(
        backend: ReturnType<typeof createDshBackend>,
        acpSessionId: string,
        model: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!option) {
            logger.warn('[dsh-acp] Cannot switch model: agent exposes no model config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot switch model: the DSH agent exposes no model config option.'
            })
            return null
        }
        try {
            this.switchingModel = true
            await backend.setConfigOption(acpSessionId, option.id, model)
            this.currentBackendModel = model
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system')
            return model
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[dsh-acp] model switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch DSH model: ${message}`
            })
            return null
        } finally {
            this.switchingModel = false
            this.refreshConfigOptions()
        }
    }

    private async handleAbort(): Promise<void> {
        this.steerEpoch++
        this.promptInFlight = false
        this.publishSteeringActive(false)
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        this.session.queue.reset({ preserveDispatchingReservations: true })
        this.session.onThinkingChange(false)
        this.abortController.abort()
        this.abortController = new AbortController()
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort())
    }
}
