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
    const label = (
        <span className="inline-flex flex-wrap items-center justify-center gap-1">
            {presentation.icon ? <span aria-hidden="true">{presentation.icon}</span> : null}
            <span>{presentation.text}</span>
            {timestamp}
        </span>
    )

    return (
        <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
            {activity ? (
                <details className="min-w-0" data-native-agent-id={activity.agentId} data-native-activity-id={activity.sourceItemId}>
                    <summary className="cursor-pointer break-words">{label}</summary>
                    <dl className="mt-2 space-y-1 break-all text-left">
                        <div><dt className="inline font-medium">Agent: </dt><dd className="inline">
                            {endpointId ? (
                                <Link to="/sessions/$sessionId" params={{ sessionId: `codex-native:${endpointId}:${activity.agentId}` }} className="underline">
                                    {activity.agentId}
                                </Link>
                            ) : activity.agentId}
                        </dd></div>
                        {activity.agentPath ? <div><dt className="inline font-medium">Work: </dt><dd className="inline">{activity.agentPath}</dd></div> : null}
                        {activity.model ? <div><dt className="inline font-medium">Model: </dt><dd className="inline">{activity.model}</dd></div> : null}
                        {activity.reasoningEffort ? <div><dt className="inline font-medium">Reasoning: </dt><dd className="inline">{activity.reasoningEffort}</dd></div> : null}
                    </dl>
                </details>
            ) : label}
        </div>
    )
}
