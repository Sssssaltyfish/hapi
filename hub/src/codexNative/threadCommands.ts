import { z } from 'zod'
import {
    MAX_CODEX_GOAL_OBJECTIVE_CHARS,
    type CodexThreadCommand,
    type NativeGoal,
    type NativeCommandRequest,
    type NativeCommandState as NativeThreadCommandState,
    type NativeCommandResult as NativeThreadCommandResult
} from '@hapi/protocol/codexThreadCommands'
import { codexRecap, codexUsage } from '@hapi/protocol/codexManagement'
import type { NativeService } from './service'
import { queueNativeInput } from './queueInput'
import { record, type NativeRecord } from './transport'

const planCommand = z.object({
    command: z.literal('plan'),
    mode: z.enum(['plan', 'default']),
    prompt: z.string().min(1).max(1_000_000).refine(value => value.trim().length > 0).optional()
}).strict()
const goalCommand = z.union([
    z.object({
        command: z.literal('goal'),
        action: z.enum(['show', 'pause', 'resume', 'clear'])
    }).strict(),
    z.object({
        command: z.literal('goal'),
        action: z.literal('set'),
        objective: z.string().min(1)
            .refine(value => Array.from(value).length <= MAX_CODEX_GOAL_OBJECTIVE_CHARS, 'Goal objective is too long')
            .refine(value => value.trim().length > 0)
    }).strict()
])
const managementCommand = z.union([
    z.object({ command: z.enum(['compact', 'recap', 'usage']) }).strict(),
    z.object({ command: z.literal('approve'), action: z.literal('show') }).strict(),
    z.object({ command: z.literal('approve'), action: z.literal('retry'), reviewId: z.string().min(1).max(500) }).strict(),
])
export const nativeThreadCommandRequest: z.ZodType<NativeCommandRequest> = z.object({
    command: z.union([planCommand, goalCommand, managementCommand]),
    clientId: z.string().min(1).max(200).optional(),
    attachments: z.array(z.object({ path: z.string().min(1) }).strict()).optional()
}).strict().superRefine((value, context) => {
    const submits = value.command.command === 'plan' && Boolean(value.command.prompt)
    if (submits && !value.clientId) {
        context.addIssue({ code: 'custom', path: ['clientId'], message: 'Plan input requires a client ID' })
    }
    if (!submits && value.attachments?.length) {
        context.addIssue({ code: 'custom', path: ['attachments'], message: 'Management commands do not consume attachments' })
    }
})

const goalSchema = z.object({
    threadId: z.string(),
    objective: z.string(),
    status: z.enum(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']),
    tokenBudget: z.number().finite().nullable(),
    tokensUsed: z.number().finite(),
    timeUsedSeconds: z.number().finite(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
})
export class NativeThreadCommandError extends Error {
    constructor(readonly status: 409 | 502, message: string, readonly details: NativeRecord = {}) {
        super(message)
    }
}
type Request = (method: string, params: NativeRecord) => Promise<unknown>

function readGoal(response: unknown, threadId: string): NativeGoal | null {
    const value = record(response)
    if (value.goal === null) return null
    const parsed = goalSchema.safeParse(value.goal)
    if (!parsed.success || parsed.data.threadId !== threadId) {
        throw new NativeThreadCommandError(502, 'Native goal state could not be confirmed')
    }
    return parsed.data
}

async function threadFeatures(request: Request, threadId: string): Promise<Map<string, NativeRecord>> {
    const features = new Map<string, NativeRecord>()
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
        const page = record(await request('experimentalFeature/list', { threadId, limit: 100, cursor }))
        if (!Array.isArray(page.data)) throw new Error('Native feature discovery returned no catalog')
        for (const value of page.data) {
            const feature = record(value)
            if (typeof feature.name === 'string') features.set(feature.name, feature)
        }
        const next = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
        if (next && seen.has(next)) throw new Error('Native feature discovery cursor did not advance')
        if (next) seen.add(next)
        cursor = next
    } while (cursor)
    return features
}

export async function discoverThreadCommands(
    request: Request,
    threadId: string,
    settings: NativeRecord | null
): Promise<NativeThreadCommandState> {
    const state: NativeThreadCommandState = {
        capabilities: { plan: false, goal: false },
        planPresets: [],
        collaborationMode: settings?.collaborationMode && typeof settings.collaborationMode === 'object'
            ? record(settings.collaborationMode) : null,
        goal: null,
        unavailable: {}
    }
    const [modes, features] = await Promise.allSettled([
        request('collaborationMode/list', {}),
        threadFeatures(request, threadId)
    ])
    if (modes.status === 'fulfilled') {
        const catalog = record(modes.value).data
        for (const raw of Array.isArray(catalog) ? catalog : []) {
            const preset = record(raw)
            if ((preset.mode === 'plan' || preset.mode === 'default') && typeof preset.name === 'string') {
                state.planPresets.push({
                    name: preset.name,
                    mode: preset.mode,
                    model: typeof preset.model === 'string' ? preset.model : null,
                    reasoning_effort: typeof preset.reasoning_effort === 'string' ? preset.reasoning_effort : null
                })
            }
        }
    }
    if (features.status === 'rejected') {
        state.unavailable.plan = 'Native thread feature settings could not be discovered'
        state.unavailable.goal = 'Native thread feature settings could not be discovered'
        return state
    }
    const collaboration = features.value.get('collaboration_modes')
    // Removed legacy flags do not disable a preset the live mode API advertises.
    const planEnabled = !collaboration || collaboration.stage === 'removed' || collaboration.enabled === true
    state.capabilities.plan = planEnabled && ['plan', 'default'].every(mode => state.planPresets.some(preset => preset.mode === mode))
    if (!state.capabilities.plan) state.unavailable.plan = 'Plan presets are unavailable for this native thread'
    if (features.value.get('goals')?.enabled !== true) {
        state.unavailable.goal = 'Native goals are not enabled for this thread'
        return state
    }
    try {
        state.goal = readGoal(await request('thread/goal/get', { threadId }), threadId)
        state.capabilities.goal = true
    } catch {
        state.unavailable.goal = 'Native goal state is unavailable on this host'
    }
    return state
}

export async function executeThreadCommand(
    native: NativeService,
    threadId: string,
    command: CodexThreadCommand,
    submission?: { input: NativeRecord[]; clientId: string }
): Promise<NativeThreadCommandResult> {
    const request: Request = (method, params) => native.control(threadId, method, params)
    if (command.command === 'usage') return codexUsage((method, params) => method.startsWith('account/')
        ? native.call(method, params) : request(method, params), threadId)
    if (command.command === 'recap') {
        try { return await codexRecap(request, threadId) }
        catch (error) { throw new NativeThreadCommandError(409, error instanceof Error ? error.message : String(error)) }
    }
    if (command.command === 'compact') {
        const runtime = record(record(await native.readThread(threadId)).thread)
        if (record(runtime.status).type === 'active') throw new NativeThreadCommandError(409, 'Wait for the native turn to finish before compacting')
        await request('thread/compact/start', {})
        return { command: 'compact', accepted: true }
    }
    if (command.command === 'approve') {
        if (command.action === 'show') return { command: 'approve', action: 'show', denial: native.guardianDenial(threadId) }
        await native.retryGuardianDenial(threadId, command.reviewId)
        return { command: 'approve', action: 'retry', reviewId: command.reviewId, accepted: true }
    }
    const state = await native.threadCommandState(threadId)
    if (command.command === 'plan') {
        const preset = state.planPresets.find(value => value.mode === command.mode)
        if (!state.capabilities.plan || !preset) {
            throw new NativeThreadCommandError(409, state.unavailable.plan ?? 'Native Plan mode is unavailable')
        }
        const result = await native.settings(threadId, current => {
            const model = preset.model ?? (typeof current.model === 'string' ? current.model : null)
            if (!model) throw new NativeThreadCommandError(409, 'Open the native thread to resolve its current model')
            const effort = preset.reasoning_effort ?? (typeof current.effort === 'string' ? current.effort : null)
            return { collaborationMode: {
                mode: preset.mode,
                settings: { model, reasoning_effort: effort, developer_instructions: null }
            } }
        })
        const applied = record(result.applied)
        if (!submission) return { command: 'plan', applied }
        try {
            const queued = await queueNativeInput(native, threadId, submission.input, submission.clientId)
            return { command: 'plan', applied, submission: queued }
        } catch (error) {
            throw new NativeThreadCommandError(502,
                error instanceof Error ? error.message : String(error),
                { applied, submission: { accepted: false, outcome: 'unconfirmed', clientId: submission.clientId } })
        }
    }
    if (!state.capabilities.goal) {
        throw new NativeThreadCommandError(409, state.unavailable.goal ?? 'Native goals are unavailable')
    }
    if (command.action === 'show') return { command: 'goal', action: 'show', goal: state.goal }
    if (command.action === 'clear') {
        const response = record(await native.control(threadId, 'thread/goal/clear', { origin: 'user' }))
        if (typeof response.cleared !== 'boolean') throw new NativeThreadCommandError(502, 'Native goal clear was not confirmed')
        return { command: 'goal', action: 'clear', cleared: response.cleared }
    }
    if (command.action !== 'set' && !state.goal) {
        throw new NativeThreadCommandError(409, 'This native thread has no goal to change')
    }
    const response = await native.control(threadId, 'thread/goal/set', {
        origin: 'user',
        ...(command.action === 'set' ? { objective: command.objective, status: 'active' }
            : { status: command.action === 'pause' ? 'paused' : 'active' })
    })
    const goal = readGoal(response, threadId)
    if (!goal) throw new NativeThreadCommandError(502, 'Native goal update was not confirmed')
    return { command: 'goal', action: command.action, goal }
}
