import { getAgyModelLabel, getAgyModelVariant } from '@hapi/protocol'
import type { AgyModelSummary } from '@/types/api'

export function getAgyModelFamilyLabel(modelId: string, name?: string): string {
    const variant = getAgyModelVariant(modelId)
    const label = name ?? getAgyModelLabel(modelId) ?? modelId
    if (!variant) return label
    if (label === modelId) return variant.baseModel
    return label.replace(new RegExp(`\\s*\\(${variant.effort}\\)\\s*$`, 'i'), '')
}

export function groupAgyModelOptions(models: readonly AgyModelSummary[], selectedModel?: string | null) {
    const families = new Map<string, { value: string; label: string }>()
    const selectedEffort = getAgyModelVariant(selectedModel)?.effort
    for (const { modelId, name } of models) {
        const variant = getAgyModelVariant(modelId)
        const family = variant?.baseModel ?? modelId
        const previous = families.get(family)
        const label = getAgyModelFamilyLabel(modelId, name)
        if (!previous) {
            families.set(family, { value: modelId, label })
            continue
        }
        if (previous.label === family) previous.label = label
        if (modelId === selectedModel || (previous.value !== selectedModel && selectedEffort && variant?.effort === selectedEffort)) {
            previous.value = modelId
        }
    }
    return [...families.values()]
}
