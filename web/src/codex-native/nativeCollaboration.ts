import { record } from './presentation'
import type { NativeRecord } from './types'
import type { AgentActivityEvent } from '@/chat/types'

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined
const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((part): part is string => Boolean(text(part))) : []

/** Each Desktop record describes an activity at that point in history. */
export function nativeSubagentEvent(item: NativeRecord): AgentActivityEvent | null {
    const agentId = text(item.agentThreadId)
    const sourceItemId = text(item.id)
    if (!agentId || !sourceItemId) return null
    const kind = text(item.kind) ?? 'interacted'
    const summary = text(item.agentPath) ?? agentId
    return {
        type: 'agent-activity',
        sourceItemId,
        agentId,
        summary,
        activityKind: kind,
        ...(text(item.agentPath) ? { agentPath: text(item.agentPath) } : {}),
        ...(text(item.model) ? { model: text(item.model) } : {}),
        ...(text(item.reasoningEffort) ? { reasoningEffort: text(item.reasoningEffort) } : {}),
    }
}

/** Match the existing runner's collaboration tool inputs/results for ToolCard. */
export function nativeCollaborationTool(item: NativeRecord) {
    const names: Record<string, string> = {
        spawnagent: 'spawn_agent', spawn: 'spawn_agent',
        sendinput: 'send_input', sendmessage: 'send_message',
        resumeagent: 'resume_agent', resume: 'resume_agent',
        followuptask: 'followup_task', assigntask: 'followup_task',
        waitagent: 'wait_agent', wait: 'wait_agent',
        closeagent: 'close_agent', close: 'close_agent',
        interruptagent: 'interrupt_agent', interrupt: 'interrupt_agent',
        listagents: 'list_agents',
    }
    const name = names[String(item.tool ?? '').toLowerCase().replace(/[\s_-]/g, '')]
    if (!name) return null
    const targets = strings(item.receiverThreadIds ?? item.receiver_thread_ids ?? item.targets)
    const states = record(item.agentsStates ?? item.agents_states)
    const timeoutMs = item.timeoutMs ?? item.timeout_ms
    const input: NativeRecord = {
        ...(text(item.prompt ?? item.message) ? { message: item.prompt ?? item.message } : {}),
        ...(text(item.agentType ?? item.agent_type) ? { agent_type: item.agentType ?? item.agent_type } : {}),
        ...(text(item.model) ? { model: item.model } : {}),
        ...(text(item.reasoningEffort ?? item.reasoning_effort) ? { reasoning_effort: item.reasoningEffort ?? item.reasoning_effort } : {}),
        ...(typeof (item.forkContext ?? item.fork_context) === 'boolean' ? { fork_context: item.forkContext ?? item.fork_context } : {}),
        ...(text(item.senderThreadId ?? item.sender_thread_id) ? { sender_thread_id: item.senderThreadId ?? item.sender_thread_id } : {}),
        ...(targets.length ? { targets, target: targets[0] } : {}),
        ...(typeof timeoutMs === 'number' ? { timeout_ms: timeoutMs } : {}),
    }
    let output: NativeRecord = { status: item.status, agentsStates: states }
    if (name === 'spawn_agent') output = {
        ...output,
        ...(targets[0] ? { agent_id: targets[0] } : {}),
        ...(text(item.agentPath ?? item.nickname) ? { nickname: item.agentPath ?? item.nickname } : {}),
    }
    if (name === 'wait_agent') {
        const timedOut = item.timedOut ?? item.timed_out
        output = {
            status: states,
            ...(typeof timedOut === 'boolean' ? { timed_out: timedOut } : {}),
            ...(item.status === 'timedOut' || item.status === 'timed_out' ? { timed_out: true } : {}),
            ...(item.status === 'completed' && Object.keys(states).length === 0 && timedOut !== true
                ? { message: 'Wait completed' } : {}),
            ...(item.status === 'interrupted' ? { message: 'Wait interrupted' } : {}),
        }
    }
    if (name === 'close_agent' || name === 'interrupt_agent') output = {
        previous_status: targets[0] ? states[targets[0]] : Object.values(states)[0],
        ...(targets[0] ? { agent_id: targets[0] } : {}),
    }
    if (item.error) output = { ...output, error: item.error, message: item.error }
    return { name, input, output }
}
