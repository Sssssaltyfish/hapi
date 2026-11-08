import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { formatQueuedSkillMessage } from '@/utils/queuedSkillReference'
import type { DshMode } from './types'

const FLASH = '["deepseek-official","deepseek-flash"]'
const PRO = '["deepseek-official","deepseek-v4-pro"]'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    modelOption: null as { id: string; category?: string; currentValue?: string } | null,
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    configOptionError: null as Error | null,
    configOptions: [] as Array<{ id: string; name?: string; category?: string; currentValue?: string; options: Array<{ value: string; name?: string }> }>,
    promptPermissions: [] as Array<string | undefined>,
    bridgeCleanup: vi.fn(async () => {}),
    rejectInFlight: null as null | ((error: Error) => void),
    promptBlocker: null as Promise<void> | null,
    steeringCapability: null as unknown,
    commandCapability: null as unknown,
    commandCatalog: [] as Array<{ name: string }>,
    skills: [] as Array<{ name: string }>,
    steerResult: null as Promise<unknown> | null,
    // When set, newSession() parks on this promise — lets tests query the
    // catalog RPC while session/new is still pending.
    newSessionBlocker: null as null | Promise<void>
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                if (harness.newSessionBlocker) {
                    await harness.newSessionBlocker
                }
                return 'dsh-session-1'
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.prompts.push(content)
                harness.promptPermissions.push(harness.configOptions.find(option => option.category === 'permission')?.currentValue)
                if (harness.promptBlocker) await harness.promptBlocker
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
            getPromptGeneration: vi.fn(() => 1),
            getAgentExtensionCapability: vi.fn((key: string) => key === 'hapi.dshCommands' ? harness.commandCapability : harness.steeringCapability),
            sendExtensionRequest: vi.fn(async (method: string, request: { operation?: string }) => method === '_hapi/dsh/command'
                ? request.operation === 'list' ? { commands: harness.commandCatalog }
                    : { commandId: 'native-command-1', result: { kind: 'success', text: 'No compactable history yet.' } }
                : await harness.steerResult),
            getConfigOptionByCategory: vi.fn(() => harness.modelOption),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            getSessionConfigOptions: vi.fn(() => harness.configOptions),
            onSessionConfigOptionsUpdate: vi.fn(),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
                if (harness.configOptionError) throw harness.configOptionError
                const option = harness.configOptions.find(option => option.id === configId)
                if (option) option.currentValue = value
                return {}
            }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => { harness.rejectInFlight?.(new Error('ACP connection closed')) })
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('./utils/permissionBridge', () => ({ prepareDshPermissionBridge: async () => ({ args: [], cleanup: harness.bridgeCleanup }) }))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))
vi.mock('@/modules/common/skills', () => ({ listSkills: async () => harness.skills }))

import { DshRemoteLauncher } from './dshRemoteLauncher'

function createSessionWithBatches(batches: Array<[string, DshMode]>) {
    const queue = new MessageQueue2<DshMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()

    return {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: { rpcHandlerManager: { registerHandler: vi.fn() }, updateMetadata: vi.fn(), updateAgentState: vi.fn(),
            setSteerDeliveryState: vi.fn(async () => true), emitMessagesConsumed: vi.fn(), emitSteerIndeterminate: vi.fn() },
        registerQueuedSteerHandler: vi.fn(() => () => {}),
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
}

function createSession(mode?: DshMode) {
    return createSessionWithBatches([['first', mode ?? {}]])
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.prompts = []
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.setConfigOptionCalls = []
        harness.configOptionError = null
        harness.configOptions = []
        harness.promptPermissions = []
        harness.bridgeCleanup.mockClear()
        harness.rejectInFlight = null
        harness.promptBlocker = null
        harness.steeringCapability = null
        harness.commandCapability = null
        harness.commandCatalog = []
        harness.skills = []
        harness.steerResult = null
        harness.newSessionBlocker = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('executes compact through the advertised native command registry without a model prompt', async () => {
        harness.commandCapability = { version: 1, method: '_hapi/dsh/command' }
        harness.commandCatalog = [{ name: 'compact' }, { name: 'permission' }]
        const session = createSession()
        session.queue.reset()
        session.queue.pushIsolated('/compact', {})
        session.queue.close()
        const launcher = new DshRemoteLauncher(session as never)
        await launcher.launch()
        expect(harness.prompts).toEqual([])
        expect(harness.backend!.sendExtensionRequest).toHaveBeenCalledWith('_hapi/dsh/command',
            { sessionId: 'dsh-session-1', operation: 'execute', text: '/compact' }, { timeoutMs: 600_000 })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'No compactable history yet.' })
        const listCommands = session.client.rpcHandlerManager.registerHandler.mock.calls.find(call => call[0] === 'listSlashCommands')![1] as () => Promise<{ commands: Array<{ name: string; source: string }> }>
        const catalog = await listCommands()
        expect(catalog.commands).toContainEqual(expect.objectContaining({ name: 'permission', source: 'plugin' }))
        expect(catalog.commands).toContainEqual(expect.objectContaining({ name: 'approve', source: 'builtin' }))
    })

    it('delivers an explicit skill through ACP despite a same-name native command', async () => {
        harness.commandCapability = { version: 1, method: '_hapi/dsh/command' }
        harness.commandCatalog = [{ name: 'compact' }]
        harness.skills = [{ name: 'compact' }]
        const session = createSession()
        session.queue.reset()
        session.queue.push('earlier prompt', {})
        const first = formatQueuedSkillMessage('$compact keep the details')
        session.queue.pushIsolated(first.message, { skillReference: first.skillReference })
        const attached = formatQueuedSkillMessage(' $compact check this', [{
            id: 'file', filename: 'notes.txt', mimeType: 'text/plain', size: 1, path: '/tmp/notes.txt'
        }])
        session.queue.pushIsolated(attached.message, { skillReference: attached.skillReference })
        const unknown = formatQueuedSkillMessage('$HOME is a variable')
        session.queue.pushIsolated(unknown.message, { skillReference: unknown.skillReference })
        session.queue.close()

        await new DshRemoteLauncher(session as never).launch()

        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'earlier prompt' }],
            [{ type: 'text', text: '/compact keep the details' }],
            [{ type: 'text', text: '@/tmp/notes.txt\n\n /compact check this' }],
            [{ type: 'text', text: '$HOME is a variable' }]
        ])
        expect(harness.backend!.sendExtensionRequest).not.toHaveBeenCalledWith(
            '_hapi/dsh/command', expect.objectContaining({ operation: 'execute' }), expect.anything()
        )
    })

    it('preserves a same-name custom command instead of executing native compaction', async () => {
        harness.commandCapability = { version: 1, method: '_hapi/dsh/command' }
        harness.commandCatalog = [{ name: 'compact' }]
        const session = createSession()
        session.queue.reset()
        session.queue.pushIsolated('/compact project-specific instructions', { customSlash: true })
        session.queue.close()
        await new DshRemoteLauncher(session as never).launch()
        expect(harness.prompts).toEqual([[{ type: 'text', text: '/compact project-specific instructions' }]])
        expect(harness.backend!.sendExtensionRequest).toHaveBeenCalledTimes(1)
    })

    it('consumes a queued steer only after native admission without another prompt', async () => {
        harness.steeringCapability = { version: 1, method: '_hapi/dsh/steer' }
        let releasePrompt!: () => void
        harness.promptBlocker = new Promise(resolve => { releasePrompt = resolve })
        let accept!: (result: unknown) => void
        harness.steerResult = new Promise(resolve => { accept = resolve })
        const session = createSession()
        session.queue.reset()
        session.queue.push('first', {})
        const launcher = new DshRemoteLauncher(session as never)
        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        session.queue.push('additional instruction', {}, 'steer-1')
        const registration = session.client.rpcHandlerManager.registerHandler.mock.calls.find(call => call[0] === 'steer-queued-message')!
        const pending = (registration[1] as (payload: unknown) => Promise<unknown>)({ localId: 'steer-1' })
        await vi.waitFor(() => expect(harness.backend?.sendExtensionRequest).toHaveBeenCalled())
        const firstDispatchFinishedAt = Date.now()
        await new Promise(resolve => setTimeout(resolve, 5))
        session.sendAgentMessage({ type: 'message', message: 'response before receipt callback' })
        const responseArrivedAt = Date.now()
        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalled()
        expect(harness.prompts).toHaveLength(1)
        accept({ accepted: true, requestId: 'steer-1', delivery: 'native-steer' })
        await expect(pending).resolves.toEqual({ steered: true })
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true, invokedAt: expect.any(Number) })
        const consumedAt = session.client.emitMessagesConsumed.mock.calls[0][1]!.invokedAt!
        expect(consumedAt).toBeLessThanOrEqual(firstDispatchFinishedAt)
        expect(consumedAt).toBeLessThan(responseArrivedAt)
        expect(harness.backend?.cancelPrompt).not.toHaveBeenCalled()
        session.queue.close()
        releasePrompt()
        await done
        expect(harness.prompts).toHaveLength(1)
    })

    it('steers the first message queued before discovery using the same effective model and presets', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.configOptions = [{ id: 'permissions', category: 'permission', currentValue: 'inspect', options: [{ value: 'inspect' }] }]
        harness.steeringCapability = { version: 1, method: '_hapi/dsh/steer' }
        harness.steerResult = Promise.resolve({ accepted: true, requestId: 'first-turn-steer', delivery: 'native-steer' })
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise(resolve => { releaseNewSession = resolve })
        let releasePrompt!: () => void
        harness.promptBlocker = new Promise(resolve => { releasePrompt = resolve })
        const session = createSession()
        session.queue.reset()
        const launcher = new DshRemoteLauncher(session as never)
        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.newSession).toHaveBeenCalled())
        expect(launcher.getConfigPreferences()).toBeUndefined()
        session.queue.push('queued before ready', {})
        releaseNewSession()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        session.queue.push('same settings after ready', { model: FLASH, configOptions: launcher.getConfigPreferences() }, 'first-turn-steer')
        const registration = session.client.rpcHandlerManager.registerHandler.mock.calls.find(call => call[0] === 'steer-queued-message')!
        await expect((registration[1] as (payload: unknown) => Promise<unknown>)({ localId: 'first-turn-steer' })).resolves.toEqual({ steered: true })
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['first-turn-steer'], { steered: true, invokedAt: expect.any(Number) })
        session.queue.close()
        releasePrompt()
        await done
        expect(harness.prompts).toHaveLength(1)
    })

    it('restores a natively rejected steer to the ordinary queue', async () => {
        harness.steeringCapability = { version: 1, method: '_hapi/dsh/steer' }
        let releasePrompt!: () => void
        harness.promptBlocker = new Promise(resolve => { releasePrompt = resolve })
        const session = createSession()
        session.queue.reset()
        session.queue.push('first', {})
        const launcher = new DshRemoteLauncher(session as never)
        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        harness.backend!.sendExtensionRequest.mockRejectedValueOnce(new Error('No active DSH prompt accepts steering'))
        session.queue.push('try next', {}, 'steer-2')
        const registration = session.client.rpcHandlerManager.registerHandler.mock.calls.find(call => call[0] === 'steer-queued-message')!
        await expect((registration[1] as (payload: unknown) => Promise<unknown>)({ localId: 'steer-2' })).resolves.toEqual({
            steered: false, error: 'No active DSH prompt accepts steering'
        })
        expect(session.queue.peekByLocalId('steer-2')?.message).toBe('try next')
        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalled()
        expect(session.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['steer-2'], 'queued')
        session.queue.close()
        releasePrompt()
        await done
        expect(harness.prompts).toHaveLength(2)
    })

    it('holds an unconfirmed steer outside automatic queue replay', async () => {
        harness.steeringCapability = { version: 1, method: '_hapi/dsh/steer' }
        harness.steerResult = Promise.resolve({})
        let releasePrompt!: () => void
        harness.promptBlocker = new Promise(resolve => { releasePrompt = resolve })
        const session = createSession()
        session.queue.reset()
        session.queue.push('first', {})
        const launcher = new DshRemoteLauncher(session as never)
        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        session.queue.push('uncertain delivery', {}, 'steer-3')
        const registration = session.client.rpcHandlerManager.registerHandler.mock.calls.find(call => call[0] === 'steer-queued-message')!
        await expect((registration[1] as (payload: unknown) => Promise<unknown>)({ localId: 'steer-3' })).resolves.toMatchObject({ steered: false })
        expect(session.client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-3'])
        expect(session.queue.peekByLocalId('steer-3')).toBeNull()
        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalled()
        session.queue.close()
        releasePrompt()
        await done
        expect(harness.prompts).toHaveLength(1)
    })

    it('applies opaque plugin permission values from each queued message before prompting', async () => {
        harness.configOptions = [{ id: 'plugin-permissions', name: 'Plugin permissions', category: 'permission', currentValue: 'plugin:edit',
            options: [{ value: 'plugin:inspect', name: 'Inspect' }, { value: 'plugin:edit', name: 'Edit' }] }]
        const session = createSessionWithBatches([
            ['inspect first', { configOptions: { 'plugin-permissions': 'plugin:inspect' } }],
            ['edit next', { configOptions: { 'plugin-permissions': 'plugin:edit' } }],
        ])
        await new DshRemoteLauncher(session as never).launch()
        expect(harness.promptPermissions).toEqual(['plugin:inspect', 'plugin:edit'])
        expect(harness.setConfigOptionCalls.map(call => call.value)).toEqual(['plugin:inspect', 'plugin:edit'])
    })

    it('does not send a queued prompt when the permission preset is refused', async () => {
        harness.configOptions = [{ id: 'permissions', category: 'permission', currentValue: 'original', options: [{ value: 'original' }, { value: 'requested' }] }]
        harness.configOptionError = new Error('Preset is no longer installed')
        const session = createSession({ configOptions: { permissions: 'requested' } })
        await new DshRemoteLauncher(session as never).launch()
        expect(harness.prompts).toEqual([])
        expect(harness.configOptions[0].currentValue).toBe('original')
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('this message was not sent') })
    })

    it('rejects a withdrawn queued preset even if a stale current value still names it', async () => {
        harness.configOptions = [{ id: 'permissions', category: 'permission', currentValue: 'removed', options: [{ value: 'available' }] }]
        const session = createSession({ configOptions: { permissions: 'removed' } })
        await new DshRemoteLauncher(session as never).launch()
        expect(harness.prompts).toEqual([])
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('no longer available') })
    })

    it('waits for ACP and temporary plugin cleanup when killed during initialization', async () => {
        harness.newSessionBlocker = new Promise((_resolve, reject) => { harness.rejectInFlight = reject })
        const launcher = new DshRemoteLauncher(createSession() as never)
        const running = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.newSession).toHaveBeenCalled())
        await launcher.kill()
        await running
        expect(harness.backend?.disconnect).toHaveBeenCalledOnce()
        expect(harness.bridgeCleanup).toHaveBeenCalledOnce()
        expect(harness.prompts).toEqual([])
    })

    it('ends an unresponsive prompt by closing ACP before waiting for cleanup', async () => {
        harness.promptBlocker = new Promise((_resolve, reject) => { harness.rejectInFlight = reject })
        const launcher = new DshRemoteLauncher(createSession() as never)
        const running = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        await launcher.kill()
        await running
        expect(harness.backend?.disconnect).toHaveBeenCalledOnce()
        expect(harness.bridgeCleanup).toHaveBeenCalledOnce()
    })

    it('discovers the current model from the model config option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never, { onConfigDiscovered })

        await launcher.launch()

        // No override → no set_config_option call, only discovery.
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(FLASH)
    })

    it('applies a spawn model override through session/set_config_option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSession({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never, { model: PRO, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'dsh-session-1',
            configId: 'model',
            value: PRO
        }])
        expect(onConfigDiscovered).toHaveBeenCalledWith(PRO)
    })

    it('switches the model per-turn when the queued mode requests a different one', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const session = createSession({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'dsh-session-1',
            configId: 'model',
            value: PRO
        }])
        // The prompt still ran after the switch.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('resets to the server default when Default is requested after a spawn-time override', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        // Production sequence: spawn with an override, user later picks
        // "Default" in the picker, next message carries model: null.
        const session = createSessionWithBatches([['first', { model: null }]])
        const launcher = new DshRemoteLauncher(session as never, { model: PRO, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, FLASH])
        expect(onConfigDiscovered).toHaveBeenCalledWith(PRO)
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('resets to the server default when Default is requested after a per-turn switch', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const session = createSessionWithBatches([
            ['first', { model: PRO }],
            ['second', { model: null }]
        ])
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, FLASH])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('keeps the running model and reports back when Default is requested but no default was discovered', async () => {
        // No model config option and no metadata: the server never reported a
        // default to reset to.
        harness.modelOption = null
        harness.modelsMetadata = null
        const onModelRollback = vi.fn()
        const session = createSessionWithBatches([
            ['first', { model: PRO }],
            ['second', { model: null }]
        ])
        const launcher = new DshRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Cannot reset the DSH model: the agent did not report a default model.'
        })
        // Both prompts still ran.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('keeps the previous model and rolls back when a per-turn switch fails', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.configOptionError = new Error('unknown model option')
        const onModelRollback = vi.fn()
        const session = createSession({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch DSH model: unknown model option'
        })
        expect(onModelRollback).toHaveBeenCalledWith(FLASH)
        // The prompt still ran with the unchanged model.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('does not treat an ordinary turn without model metadata as a reset request', async () => {
        // No model option and no metadata: the server never reported a model,
        // so a preference-less turn (mode {}) must run as an ordinary prompt
        // without emitting the reset-failure event.
        harness.modelOption = null
        harness.modelsMetadata = null
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const resetFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('Cannot reset'))
        expect(resetFailures).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('answers ListDshModels once a delayed session/new completes', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        }
        // Park session/new: the picker's catalog query arrives while the ACP
        // session is still being created.
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNewSession = resolve })
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listDshModels')
            expect(call).toBeTruthy()
            return call!
        })

        // The handler is registered before initialization; invoking it while
        // session/new is pending must park on readiness, not fail.
        const pending = (registered[1] as () => Promise<unknown>)()
        releaseNewSession()
        await done

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        })
    })

    it('serves ListDshModels with the live current model', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [
                { modelId: FLASH, name: 'DeepSeek-V41-Flash' },
                { modelId: PRO, name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: FLASH
        }
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        const registered = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
            .find((call) => call[0] === 'listDshModels')
        expect(registered).toBeTruthy()
        const handler = registered![1] as () => Promise<unknown>
        await expect(handler()).resolves.toEqual({
            success: true,
            availableModels: [
                { modelId: FLASH, name: 'DeepSeek-V41-Flash' },
                { modelId: PRO, name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: FLASH
        })
    })
})
