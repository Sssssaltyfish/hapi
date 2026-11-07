import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { AgentEvent } from '@/chat/types'
import { isAgentActivityEvent } from '@/chat/types'
import { getEventPresentation } from '@/chat/presentation'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { CodexUsageSnapshotSchema } from '@hapi/protocol/codexUsage'
import { CodexUsagePanel } from '@/components/CodexUsagePanel'

/** Shared event content for timeline rows and nested tool traces. */
export function EventMessage({ event, timestamp }: { event: AgentEvent; timestamp?: ReactNode }) {
    const context = useOptionalHappyChatContext()
    const usage = event.type === 'message' ? CodexUsageSnapshotSchema.safeParse(event.codexUsage) : null
    if (usage?.success) return <div className="mx-auto w-full max-w-2xl px-3 py-2"><CodexUsagePanel snapshot={usage.data} /></div>
    const presentation = getEventPresentation(event)
    const activity = isAgentActivityEvent(event) ? event : null
    const endpointId = context?.metadata?.nativeCodex?.endpointId
    const text = activity && endpointId ? (
        <Link
            to="/sessions/$sessionId"
            params={{ sessionId: `codex-native:${endpointId}:${activity.agentId}` }}
            className="underline"
        >
            {presentation.text}
        </Link>
    ) : <span>{presentation.text}</span>
    const label = (
        <span className="inline-flex flex-wrap items-center justify-center gap-x-1.5">
            {presentation.icon ? <span aria-hidden="true">{presentation.icon}</span> : null}
            {text}
            {activity?.model ? <span>{activity.model}</span> : null}
            {activity?.reasoningEffort ? <span>{activity.reasoningEffort}</span> : null}
            {timestamp}
        </span>
    )

    return (
        <div
            className="mx-auto w-fit max-w-[92%] break-all px-2 text-center text-xs text-[var(--app-hint)] opacity-80"
            data-native-agent-id={activity?.agentId}
            data-native-activity-id={activity?.sourceItemId}
        >
            {label}
        </div>
    )
}
