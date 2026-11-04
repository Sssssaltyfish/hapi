import type { CodexModelSummary } from '@/types/api'
import { record } from './presentation'

/** The existing chat controls consume HAPI summaries, not native model/list records. */
export function nativeModelSummaries(values: unknown[]): CodexModelSummary[] {
    const text = (value: unknown) =>
        typeof value === 'string' && value.trim() ? value.trim() : null
    return values.flatMap((value) => {
        const model = record(value)
        const id = text(model.id) ?? text(model.model)
        if (!id) return []
        const efforts = Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
                  .map((value) => text(record(value).reasoningEffort))
                  .filter((value): value is string => value !== null)
            : []
        const tiers = Array.isArray(model.serviceTiers)
            ? model.serviceTiers
                  .flatMap((value) => [text(record(value).id), text(record(value).name)])
                  .filter((value): value is string => value !== null)
                  .map((value) => value.toLowerCase())
            : []
        return [
            {
                id,
                displayName: text(model.displayName) ?? id,
                isDefault: model.isDefault === true,
                defaultReasoningEffort: text(model.defaultReasoningEffort),
                defaultServiceTier: text(model.defaultServiceTier),
                supportedReasoningEfforts: efforts.length ? [...new Set(efforts)] : undefined,
                serviceTiers: tiers.length ? [...new Set(tiers)] : undefined,
            },
        ]
    })
}
