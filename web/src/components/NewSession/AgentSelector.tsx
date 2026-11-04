import type { CreationChoice } from './creationChoices'
import { getAgentIdentityLabel } from '@/lib/agentIdentity'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { useTranslation } from '@/lib/use-translation'

export type AgentSelection = CreationChoice

export function AgentSelector(props: {
    agent: AgentSelection
    agents: readonly AgentSelection[]
    isDisabled: boolean
    disabledAgents?: readonly AgentSelection[]
    onAgentChange: (value: AgentSelection) => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.agent')}
            </label>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
                {props.agents.map((agentType) => (
                    <label
                        key={agentType}
                        className="flex items-center gap-1.5 cursor-pointer"
                    >
                        <input
                            type="radio"
                            name="agent"
                            value={agentType}
                            checked={props.agent === agentType}
                            onChange={() => props.onAgentChange(agentType)}
                            disabled={props.isDisabled || props.disabledAgents?.includes(agentType)}
                            className="accent-[var(--app-link)]"
                        />
                        <AgentFlavorIcon flavor={agentType} className="h-4 w-4 shrink-0" />
                        <span className="text-sm">{getAgentIdentityLabel(agentType)}</span>
                    </label>
                ))}
            </div>
        </div>
    )
}
