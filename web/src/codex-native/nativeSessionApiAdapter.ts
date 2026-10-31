import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { CodexApprovalPolicy, CodexApprovalsReviewer } from '@hapi/protocol'
import { resolveCodexModel } from '@/lib/codexModelCapabilities'
import { nativeModelSummaries } from './nativeModels'
import { nativeAsyncReplyTurn, record } from './presentation'
import type { useNativeThread } from './useNativeThread'
import type { projectNativeItems } from './projectNativeItems'

type SupportedOperation =
    | 'getSessionCodexModels'
    | 'renameSession'
    | 'archiveSession'
    | 'uploadFile'
    | 'deleteUploadFile'
    | 'abortSession'
    | 'setModel'
    | 'setModelReasoningEffort'
    | 'approvePermission'
    | 'denyPermission'
    | 'setNativeApprovalSettings'
export type NativeApprovalSettingsPatch = {
    approvalPolicy?: CodexApprovalPolicy
    approvalsReviewer?: CodexApprovalsReviewer
}
export type NativeSessionApiAdapter = ApiClient & {
    setNativeApprovalSettings: (patch: NativeApprovalSettingsPatch) => Promise<void>
}
type AdapterOptions = {
    session: Session
    liveSession: Session
    thread: Pick<
        ReturnType<typeof useNativeThread>,
        'requests' | 'detail' | 'refreshDetail' | 'applySettings'
    >
    projected: Pick<ReturnType<typeof projectNativeItems>, 'requests'>
    setSettingsError: (error: string | null) => void
}

// Only these non-conversation services may delegate to the original client.
// New methods are denied until deliberately classified here or implemented below.
const GLOBAL_OPERATIONS = [
    'authenticate',
    'bind',
    'getSessions',
    'getSession',
    'getHealth',
    'getPushVapidPublicKey',
    'subscribePushNotifications',
    'unsubscribePushNotifications',
    'setVisibility',
    'getMachines',
    'renameMachine',
    'getSqliteStorageUsage',
    'getHubSettings',
    'updateHubSettings',
    'getUsageSummary',
    'restartMachineRunner',
    'listMachineDirectory',
    'getMachineAgentAvailability',
    'checkMachinePathsExists',
    'spawnSession',
    'getMachineAgyModels',
    'getMachineDshModels',
    'getMachinePiModels',
    'getMachineCodexModels',
    'getMachineCursorModels',
    'getMachineOpencodeModelsForCwd',
    'getMachineOpencodeModelVariants',
    'getMachineGrokModelsForCwd',
    'getMachineCopilotModelsForCwd',
    'getMachineKimiModelsForCwd',
    'fetchVoiceToken',
    'fetchVoices',
    'sendVoiceTelemetry',
    'getAuthToken',
    'fetchVoiceBackend',
    'fetchTranscriptionProviders',
    'fetchTranscriptionCredentials',
    'updateTranscriptionCredentials',
    'transcribeVoice',
    'fetchRealtimeTranscriptionToken',
    'fetchQwenToken',
    'fetchGeminiToken',
    'getCodexNativeStatus',
    'withCodexNativeEndpoint',
    'getCodexNativeEndpoints',
    'createCodexNativeThread',
    'readCodexNativeFile',
    'readCodexNativeDirectory',
    'getCodexNativeThreads',
    'getCodexNativeThread',
    'getCodexNativeActiveTurn',
    'uploadCodexNativeFile',
    'deleteCodexNativeUpload',
    'getCodexNativeItems',
    'getCodexNativeModels',
    'codexNativeAction',
    'streamCodexNativeEvents',
] as const satisfies readonly (keyof ApiClient)[]

export function createNativeSessionApiAdapter(
    target: ApiClient,
    options: AdapterOptions
): NativeSessionApiAdapter {
    const { session, liveSession, thread, projected, setSettingsError } = options
    const native = session.metadata!.nativeCodex!
    const nativeAction = (
        action: 'settings' | 'interrupt' | `requests/${string}`,
        payload: Record<string, unknown>
    ) => target.codexNativeAction(native.threadId, action, payload)
    async function changeSettings(
        property: 'setModel' | 'setModelReasoningEffort',
        value: unknown
    ) {
        setSettingsError(null)
        try {
            const models = nativeModelSummaries((await target.getCodexNativeModels()).data)
            const selected = resolveCodexModel(
                models,
                property === 'setModel'
                    ? typeof value === 'string'
                        ? value
                        : null
                    : liveSession.model
            )
            const patch: Record<string, string> = {}
            if (property === 'setModel') {
                if (!selected) throw new Error('Native model is unavailable')
                patch.model = selected.id
                const effort = liveSession.modelReasoningEffort
                if (
                    effort &&
                    selected.supportedReasoningEfforts &&
                    !selected.supportedReasoningEfforts.includes(effort) &&
                    selected.defaultReasoningEffort
                ) {
                    patch.effort = selected.defaultReasoningEffort
                }
            } else {
                const effort = typeof value === 'string' ? value : selected?.defaultReasoningEffort
                if (!effort)
                    throw new Error(
                        'The native model does not advertise a default reasoning effort'
                    )
                patch.effort = effort
            }
            const result = await nativeAction('settings', patch)
            thread.applySettings(record(result.applied))
        } catch (error) {
            setSettingsError(error instanceof Error ? error.message : String(error))
            throw error
        }
    }
    async function answerRequest(
        property: 'approvePermission' | 'denyPermission',
        requestId: string,
        options?: unknown
    ) {
        if (requestId.startsWith('native-async:')) {
            const questions = record(projected.requests[requestId]?.arguments).questions
            if (!Array.isArray(questions)) throw new Error('Question is no longer pending')
            const answers = record(record(options).answers)
            const replies = questions.map(record).map((question) => {
                const value = answers[String(question.id)]
                const selected = Array.isArray(value) ? value : record(value).answers
                return {
                    questionItemId: question.id,
                    question: question.question,
                    answer: Array.isArray(selected) ? selected.map(String).join('\n') : '',
                }
            })
            await target.codexNativeAction(native.threadId, 'messages', {
                text: `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`,
                clientId: crypto.randomUUID(),
                ...(nativeAsyncReplyTurn(thread.detail.activeTurn)
                    ? { expectedTurnId: nativeAsyncReplyTurn(thread.detail.activeTurn) }
                    : {}),
            })
            return
        }
        const request = thread.requests.find((value) => String(value.id) === requestId)
        if (!request) throw new Error('Native request is no longer pending')
        const isQuestion = request.method === 'item/tool/requestUserInput'
        const isApproval =
            request.method === 'item/commandExecution/requestApproval' ||
            request.method === 'item/fileChange/requestApproval'
        if (!isQuestion && !isApproval)
            throw new Error('This native request requires Codex Desktop')
        const supplied = record(options)
        if (isQuestion) {
            const answers = Object.fromEntries(
                Object.entries(record(supplied.answers)).map(([questionId, value]) => {
                    const selected = Array.isArray(value) ? value : record(value).answers
                    return [
                        questionId,
                        { answers: Array.isArray(selected) ? selected.map(String) : [] },
                    ]
                })
            )
            await nativeAction(`requests/${encodeURIComponent(requestId)}`, { result: { answers } })
        } else {
            const requestedDecision = supplied.decision
            const decision =
                requestedDecision === 'approved_for_session'
                    ? 'acceptForSession'
                    : requestedDecision === 'abort'
                      ? 'cancel'
                      : requestedDecision === 'denied'
                        ? 'decline'
                        : requestedDecision === 'approved'
                          ? 'accept'
                          : property === 'denyPermission'
                            ? 'decline'
                            : 'accept'
            await nativeAction(`requests/${encodeURIComponent(requestId)}`, {
                result: { decision },
            })
        }
    }
    const operations = {
        setNativeApprovalSettings: async (patch) => {
            setSettingsError(null)
            try {
                const result = await nativeAction('settings', patch)
                thread.applySettings(record(result.applied))
            } catch (error) {
                setSettingsError(error instanceof Error ? error.message : String(error))
                throw error
            }
        },
        getSessionCodexModels: async () => ({
            success: true,
            models: nativeModelSummaries((await target.getCodexNativeModels()).data),
        }),
        renameSession: async (_id, name) => target.renameSession(session.id, name),
        archiveSession: async () => target.archiveSession(session.id),
        uploadFile: async (_id, filename, content, mimeType) =>
            target.uploadCodexNativeFile(native.threadId, filename, content, mimeType),
        deleteUploadFile: async (_id, path) =>
            target.deleteCodexNativeUpload(native.threadId, path),
        abortSession: async () => {
            await nativeAction('interrupt', {})
            await thread.refreshDetail()
        },
        setModel: async (_id, value) => changeSettings('setModel', value),
        setModelReasoningEffort: async (_id, value) =>
            changeSettings('setModelReasoningEffort', value),
        approvePermission: async (_id, requestId, options) =>
            answerRequest('approvePermission', requestId, options),
        denyPermission: async (_id, requestId, options) =>
            answerRequest('denyPermission', requestId, options),
    } satisfies Pick<NativeSessionApiAdapter, SupportedOperation>
    const globals: ReadonlySet<PropertyKey> = new Set(GLOBAL_OPERATIONS)
    return new Proxy(target, {
        get(client, property) {
            if (Object.hasOwn(operations, property))
                return operations[property as SupportedOperation]
            const value: unknown = Reflect.get(client, property, client)
            if (typeof value !== 'function') return value
            if (globals.has(property)) return value.bind(client)
            return () => {
                throw new Error('This operation is unavailable for native Codex conversations')
            }
        },
    }) as NativeSessionApiAdapter
}
