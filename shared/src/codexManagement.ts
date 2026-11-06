import type { NativeCommandResult } from './codexThreadCommands'
import { normalizeCodexUsage } from './codexUsage'
export { codexRecap, type CodexRecapTransport, type CodexRecapOptions } from './codexRecap'

type RecordValue = Record<string, unknown>
type Request = (method: string, params: RecordValue) => Promise<unknown>

const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

export type CodexDenial = { reviewId: string; turnId: string; action: RecordValue; rationale: string | null }

/** Retain only daemon-observed denials. A browser may identify a review, never author its action. */
export class CodexGuardianDenials {
    private latest: { summary: CodexDenial; event: RecordValue } | null = null
    private attempted = new Set<string>()

    clear(): void {
        this.latest = null
    }

    observe(threadId: string, method: string, params: unknown): void {
        const p = record(params)
        if (p.threadId !== threadId) return
        if (method === 'turn/started') {
            this.clear()
            return
        }
        let event: RecordValue
        if (method === 'codex/event/guardian_assessment') {
            event = record(p.msg)
        } else if (method === 'item/autoApprovalReview/completed') {
            const review = record(p.review)
            const action = guardianAction(record(p.action))
            if (!action) return
            // v2 publishes the same assessment using camelCase field names.
            event = {
                id: p.reviewId, turn_id: p.turnId, target_item_id: p.targetItemId,
                started_at_ms: p.startedAtMs, completed_at_ms: p.completedAtMs,
                status: review.status, risk_level: review.riskLevel,
                user_authorization: review.userAuthorization, rationale: review.rationale,
                decision_source: p.decisionSource, action,
            }
        } else return
        const id = string(event.id)
        const turnId = string(event.turn_id)
        if (!id || !turnId) return
        if (event.status !== 'denied' || event.decision_source !== 'agent') {
            if (this.latest?.summary.reviewId === id) this.clear()
            return
        }
        if (!['command', 'execve', 'write_stdin', 'apply_patch', 'network_access', 'mcp_tool_call', 'request_permissions']
            .includes(String(record(event.action).type)) || this.attempted.has(id)) return
        this.latest = { summary: { reviewId: id, turnId, action: record(event.action), rationale: string(event.rationale) ?? null }, event }
    }

    show(): CodexDenial | null {
        return this.latest ? structuredClone(this.latest.summary) : null
    }

    claim(reviewId: string): RecordValue | null {
        if (!this.latest || this.latest.summary.reviewId !== reviewId || this.attempted.has(reviewId)) return null
        const event = this.latest.event
        this.clear()
        // Claim before writing: a lost ACK must never silently retry the action twice.
        this.attempted.add(reviewId)
        return structuredClone(event)
    }
}

function guardianAction(action: RecordValue): RecordValue | null {
    const source = action.source === 'unifiedExec' ? 'unified_exec' : action.source
    switch (action.type) {
        case 'command':
            return { type: 'command', source, command: action.command, cwd: action.cwd }
        case 'execve':
            return { type: 'execve', source, program: action.program, argv: action.argv, cwd: action.cwd }
        case 'writeStdin':
            return { type: 'write_stdin', approval_id: action.approvalId, process_id: action.processId, stdin: action.stdin, cwd: action.cwd }
        case 'applyPatch':
            return { type: 'apply_patch', cwd: action.cwd, files: action.files }
        case 'networkAccess':
            return { type: 'network_access', target: action.target, host: action.host, protocol: action.protocol, port: action.port }
        case 'mcpToolCall':
            return {
                type: 'mcp_tool_call', server: action.server, tool_name: action.toolName,
                connector_id: action.connectorId, connector_name: action.connectorName, tool_title: action.toolTitle,
            }
        case 'requestPermissions':
            return { type: 'request_permissions', reason: action.reason, permissions: guardianPermissions(record(action.permissions)) }
        default:
            return null
    }
}

function guardianPermissions(permissions: RecordValue): RecordValue {
    const fileSystem = record(permissions.fileSystem)
    return {
        network: permissions.network ?? null,
        file_system: permissions.fileSystem == null ? null
            : Array.isArray(fileSystem.entries) ? {
                entries: fileSystem.entries,
                ...(fileSystem.globScanMaxDepth === undefined ? {} : { glob_scan_max_depth: fileSystem.globScanMaxDepth }),
            } : { read: fileSystem.read ?? null, write: fileSystem.write ?? null },
    }
}

export async function codexUsage(request: Request, threadId: string): Promise<Extract<NativeCommandResult, { command: 'usage' }>> {
    const [usage, limits] = await Promise.allSettled([
        request('account/usage/read', { threadId }),
        request('account/rateLimits/read', {}),
    ])
    const unavailable: { usage?: string; rateLimits?: string } = {}
    const read = (result: PromiseSettledResult<unknown>, key: 'usage' | 'rateLimits') => {
        if (result.status === 'fulfilled' && Object.keys(record(result.value)).length > 0) return record(result.value)
        unavailable[key] = result.status === 'rejected'
            ? result.reason instanceof Error ? result.reason.message : String(result.reason)
            : 'The native host returned no usage data'
        return null
    }
    const usageValue = read(usage, 'usage')
    const limitsValue = read(limits, 'rateLimits')
    return { command: 'usage', snapshot: normalizeCodexUsage(usageValue, limitsValue, unavailable) }
}
