import {
    getCodexCollaborationModeLabel,
    getCopilotAgentModeLabel,
    getPermissionModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import type { PermissionModeTone } from '@hapi/protocol'
import { useMemo, useState } from 'react'
import type { AgentState, CodexCollaborationMode, PermissionMode } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import {
    formatReasoningLabel,
    formatCompactReasoningLabel,
    getReasoningEffortForFlavor,
    shouldShowReasoningStatusLabel
} from '@/lib/codexStatusLabels'
import { isFastServiceTier } from './codexFastMode'
import { useTranslation } from '@/lib/use-translation'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'

// Vibing messages for thinking state
const VIBING_MESSAGES = [
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
    "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
    "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
    "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
    "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
    "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
    "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering",
    "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating",
    "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating",
    "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking",
    "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
    "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring",
    "Wibbling", "Wizarding", "Working", "Wrangling"
]

const PERMISSION_TONE_CLASSES: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-hint)]',
    info: 'text-blue-500',
    warning: 'text-amber-500',
    danger: 'text-red-500'
}

const CONTEXT_WARNING_THRESHOLD_PERCENT = 70
const CONTEXT_DANGER_THRESHOLD_PERCENT = 90

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    agentState: AgentState | null | undefined,
    voiceStatus: ConversationStatus | undefined,
    backgroundTaskCount: number,
    t: (key: string) => string
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    // Voice connecting takes priority
    if (voiceStatus === 'connecting') {
        return {
            text: t('voice.connecting'),
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (!active) {
        return {
            text: t('misc.offline'),
            color: 'text-[#999]',
            dotColor: 'bg-[#999]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: t('misc.permissionRequired'),
            color: 'text-[#FF9500]',
            dotColor: 'bg-[#FF9500]',
            isPulsing: true
        }
    }

    if (thinking) {
        const vibingMessage = VIBING_MESSAGES[Math.floor(Math.random() * VIBING_MESSAGES.length)].toLowerCase() + '…'
        return {
            text: vibingMessage,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (backgroundTaskCount > 0) {
        return {
            text: `${backgroundTaskCount} background task${backgroundTaskCount > 1 ? 's' : ''} running`,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    return {
        text: t('misc.online'),
        color: 'text-[#34C759]',
        dotColor: 'bg-[#34C759]',
        isPulsing: false
    }
}

export function getContextWarning(contextSize: number, maxContextSize: number): { color: string } {
    const percentageUsed = (contextSize / maxContextSize) * 100

    if (percentageUsed >= CONTEXT_DANGER_THRESHOLD_PERCENT) {
        return { color: 'text-[var(--app-badge-error-text)]' }
    } else if (percentageUsed >= CONTEXT_WARNING_THRESHOLD_PERCENT) {
        return { color: 'text-[var(--app-badge-warning-text)]' }
    } else {
        return { color: 'text-[var(--app-hint)]' }
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

export function formatContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined, showTokens = false): string {
    if (!maxContextSize) return `ctx ${formatTokenCount(contextSize)}`
    return showTokens
        ? `ctx ${formatTokenCount(contextSize)} / ${formatTokenCount(maxContextSize)}`
        : `ctx ${Math.round(contextSize / maxContextSize * 100)}%`
}

export function shouldShowCodexFastBadge(
    agentFlavor: string | null | undefined,
    serviceTier: string | null | undefined
): boolean {
    return agentFlavor === 'codex' && isFastServiceTier(serviceTier)
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    backgroundTaskCount?: number
    contextSize?: number
    contextWindow?: number | null
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    serviceTier?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: import('@hapi/protocol').CopilotAgentMode
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
}) {
    const { t } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount ?? 0, t),
        [props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount, t]
    )

    const [showContextTokens, setShowContextTokens] = useState(false)
    const contextSize = typeof props.contextSize === 'number' && Number.isSafeInteger(props.contextSize) && props.contextSize >= 0 ? props.contextSize : null
    const contextWindow = typeof props.contextWindow === 'number' && Number.isSafeInteger(props.contextWindow) && props.contextWindow > 0 ? props.contextWindow : null
    const contextWarning = contextSize !== null && contextWindow ? getContextWarning(contextSize, contextWindow) : null
    const contextUsageLabel = contextSize !== null && contextWindow ? formatContextUsageLabel(contextSize, contextWindow, showContextTokens) : null

    const permissionMode = props.permissionMode
    // Copilot always shows permission (including Default) so model=auto sessions
    // still surface the bottom-right mode chip. Other flavors keep Codex-style
    // "hide default" parity.
    const displayPermissionMode = permissionMode
        && isPermissionModeAllowedForFlavor(permissionMode, props.agentFlavor)
        && (permissionMode !== 'default' || props.agentFlavor === 'copilot')
        ? permissionMode
        : null

    const permissionModeLabel = displayPermissionMode ? getPermissionModeLabel(displayPermissionMode) : null
    const permissionModeTone = displayPermissionMode ? getPermissionModeTone(displayPermissionMode) : null
    const permissionModeColor = permissionModeTone ? PERMISSION_TONE_CLASSES[permissionModeTone] : 'text-[var(--app-hint)]'
    const displayCollaborationMode = props.agentFlavor === 'codex' && props.collaborationMode === 'plan'
        ? props.collaborationMode
        : null
    const collaborationModeLabel = displayCollaborationMode
        ? getCodexCollaborationModeLabel(displayCollaborationMode)
        : null
    const displayCopilotAgentMode = props.agentFlavor === 'copilot'
        && props.copilotAgentMode
        && props.copilotAgentMode !== 'interactive'
        ? props.copilotAgentMode
        : null
    const copilotAgentModeLabel = displayCopilotAgentMode
        ? getCopilotAgentModeLabel(displayCopilotAgentMode)
        : null
    const reasoningEffort = getReasoningEffortForFlavor(
        props.agentFlavor,
        props.modelReasoningEffort,
        props.effort
    )
    const displaysReasoning = shouldShowReasoningStatusLabel(props.agentFlavor, reasoningEffort)
    const reasoningLabel = displaysReasoning
        ? formatReasoningLabel(reasoningEffort, headerMetadata.showLabels)
        : null
    const compactReasoningLabel = displaysReasoning
        ? formatCompactReasoningLabel(reasoningEffort)
        : null
    const codexFastMode = shouldShowCodexFastBadge(props.agentFlavor, props.serviceTier)

    return (
        <div className="flex min-w-0 items-baseline justify-between gap-2 px-2 pb-1">
            <div className="flex min-w-0 items-baseline gap-2">
                <div className="relative top-px sm:top-0.5 flex shrink-0 items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`whitespace-nowrap text-xs ${connectionStatus.color}`}>
                        {connectionStatus.text}
                    </span>
                </div>
            </div>

            <div className="flex min-w-0 shrink-0 items-baseline gap-2">
                {reasoningLabel ? (
                    <span className="whitespace-nowrap text-xs text-[var(--app-hint)]">
                        <span className="sm:hidden">{compactReasoningLabel}</span>
                        <span className="hidden sm:inline">{reasoningLabel}</span>
                    </span>
                ) : null}
                {contextUsageLabel ? (
                    <button
                        type="button"
                        aria-label={t('misc.contextDetails')}
                        aria-pressed={showContextTokens}
                        disabled={!contextWindow}
                        onClick={() => setShowContextTokens(value => !value)}
                        title={contextSize !== null ? formatContextUsageLabel(contextSize, contextWindow, true) : undefined}
                        className={`whitespace-nowrap rounded-sm bg-transparent p-0 text-xs outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${contextWarning?.color ?? 'text-[var(--app-hint)]'}`}
                    >
                        {contextUsageLabel}
                    </button>
                ) : null}
                {codexFastMode ? (
                    <span className="whitespace-nowrap text-xs text-[#34C759]">
                        fast
                    </span>
                ) : null}
                {collaborationModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {collaborationModeLabel}
                    </span>
                ) : null}
                {copilotAgentModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {copilotAgentModeLabel}
                    </span>
                ) : null}
                {displayPermissionMode ? (
                    <span className={`whitespace-nowrap text-xs ${permissionModeColor}`}>
                        {permissionModeLabel}
                    </span>
                ) : null}
            </div>
        </div>
    )
}
