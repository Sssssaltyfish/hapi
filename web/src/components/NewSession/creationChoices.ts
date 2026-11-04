import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'
import type { AgentType } from './types'

/** Presentation choices keep execution transport separate from the wire flavor. */
export type CreationChoice = AgentType | 'codex-native'
export type CreationTarget =
    | { kind: 'runner'; machineId: string | null }
    | { kind: 'native'; endpointId: string | null }

export const CREATION_CHOICES: readonly CreationChoice[] = [...CREATABLE_AGENT_FLAVORS, 'codex-native']

export function creationChoiceFlavor(choice: CreationChoice): AgentType {
    return choice === 'codex-native' ? 'codex' : choice
}

export function disabledCreationChoices(availableAgents: readonly AgentType[]): CreationChoice[] {
    return CREATION_CHOICES.filter((choice) => choice !== 'codex-native' && !availableAgents.includes(choice))
}
