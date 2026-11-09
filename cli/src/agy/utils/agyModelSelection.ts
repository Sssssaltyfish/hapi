import { getAgyModelVariant, getAgyModelEffortLevels, isAgyEffortLevel } from '@hapi/protocol'

/** Resolve an effort change to a variant actually published by this machine. */
export function resolveAgyModelSelection(
    model: string | null,
    effort: string | null | undefined,
    catalogIds: readonly string[],
): { model: string | null; effort: string | null } {
    if (effort != null && !isAgyEffortLevel(effort)) throw new Error('Invalid Antigravity effort')
    if (!model) return { model, effort: effort ?? null }

    const variant = getAgyModelVariant(model)
    const baseModel = variant?.baseModel ?? model
    const available = getAgyModelEffortLevels(model, catalogIds)
    // Custom models and aliases stay opaque; AGY owns their validation.
    if (available.length === 0 || (variant && !catalogIds.includes(model))) {
        return { model, effort: effort ?? null }
    }
    if (effort == null) return { model, effort: variant?.effort ?? null }
    if (!available.includes(effort)) {
        throw new Error(`${baseModel} has no "${effort}" effort (available: ${available.join(', ')})`)
    }
    return { model: `${baseModel}-${effort}`, effort }
}
