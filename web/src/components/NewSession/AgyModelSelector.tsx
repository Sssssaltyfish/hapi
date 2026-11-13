import { CLAUDE_EFFORT_LABELS, getAgyModelEffortLevels, getAgyModelVariant } from '@hapi/protocol'
import { getAgyModelFamilyLabel, groupAgyModelOptions } from '@/lib/agyModelOptions'
import { useTranslation } from '@/lib/use-translation'
import type { AgyModelSummary } from '@/types/api'
import { SelectControl } from '@/components/ui/select-control'
import { ModelCatalogRefresh } from '@/components/ModelCatalogRefresh'

export type AgyModelSelectorProps = {
    machineId: string | null
    isLoading: boolean
    error: string | null
    /** Catalog is usable, but the machine's last sign-in check failed. */
    warning?: string | null
    /** A probe is in flight — asking the machine again can take a while. */
    isFetching?: boolean
    availableModels: AgyModelSummary[]
    selectedModel: string | null
    currentModelId?: string | null
    isDisabled?: boolean
    onModelChange: (modelId: string | null) => void
    onRetry?: () => void
    onOpen?: () => void
}

/** The catalog can change under an open form, so a model the user already picked
 *  stays listed rather than the select falling blank — labelled, because starting
 *  a session on it is their call but agy is no longer offering it.
 *
 *  `withCurrentModelOption` in AssistantChat/modelOptions.ts leaves the
 *  equivalent entry unlabelled on purpose: there it is the model the session is
 *  already running, a fact rather than a choice about to be made. */
function withSelectedModel(
    models: AgyModelSummary[],
    selectedModel: string | null,
    notListedSuffix: string
): AgyModelSummary[] {
    if (!selectedModel || models.some((model) => model.modelId === selectedModel)) {
        return models
    }
    const label = getAgyModelFamilyLabel(selectedModel)
    return [{ modelId: selectedModel, name: `${label} (${notListedSuffix})` }, ...models]
}

export function AgyModelSelector(props: AgyModelSelectorProps) {
    const { t } = useTranslation()

    if (!props.machineId) {
        return null
    }

    const effectiveModel = props.selectedModel ?? props.currentModelId ?? null
    const selectedVariant = getAgyModelVariant(effectiveModel)
    const selectedFamily = selectedVariant?.baseModel ?? effectiveModel
    const efforts = getAgyModelEffortLevels(effectiveModel, props.availableModels.map(model => model.modelId))
    const defaultModel = props.availableModels.find(model => model.modelId === props.currentModelId)
    const modelOptions = groupAgyModelOptions(withSelectedModel(
        props.availableModels,
        props.selectedModel,
        t('newSession.agyModel.notListed')
    ), effectiveModel)
    const selectClassName = 'py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50'

    return (
        <div className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-center justify-between text-xs font-medium text-[var(--app-hint)]">
                <span>
                    {t('newSession.model')}{' '}
                    <span className="font-normal">({t('newSession.model.optional')})</span>
                </span>
                {props.onRetry ? <ModelCatalogRefresh onRefresh={props.onRetry} isFetching={props.isFetching} /> : null}
            </div>

            {props.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--app-divider)] border-t-[var(--app-link)]" />
                    <span>{t('newSession.agyModel.fetchingModels')}</span>
                </div>
            ) : props.error ? (
                <div className="flex flex-col gap-2" data-testid="agy-model-auth-error">
                    <div className="text-xs text-red-600">
                        {props.error}
                    </div>
                </div>
            ) : props.availableModels.length === 0 ? (
                <div className="text-xs text-[var(--app-hint)]">
                    {t('newSession.agyModel.noModels')}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {props.warning ? (
                        <div className="flex flex-col gap-1" data-testid="agy-model-stale-warning">
                            <div className="text-xs text-amber-600">
                                {t('newSession.agyModel.authRequired')}: {props.warning}
                            </div>
                            <div className="text-xs text-[var(--app-hint)]">
                                {t('newSession.agyModel.authHint')}
                            </div>
                        </div>
                    ) : null}
                    <SelectControl
                        data-testid="agy-model-list"
                        value={props.selectedModel ?? ''}
                        disabled={props.isDisabled}
                        onFocus={props.onOpen}
                        onChange={(e) => props.onModelChange(e.target.value || null)}
                        className={selectClassName}
                    >
                        <option value="">{defaultModel
                            ? `${getAgyModelFamilyLabel(defaultModel.modelId, defaultModel.name)} (${t('newSession.model.default')})`
                            : t('newSession.model.default')}</option>
                        {modelOptions.map(({ value, label }) => (
                            <option key={value} value={value}>
                                {label}
                            </option>
                        ))}
                    </SelectControl>
                    {selectedFamily && efforts.length > 0 ? (
                        <label className="flex flex-col gap-1.5 pt-1 text-xs font-medium text-[var(--app-hint)]">
                            {t('newSession.effort')}
                            <SelectControl
                                value={selectedVariant?.effort ?? ''}
                                disabled={props.isDisabled}
                                onFocus={props.onOpen}
                                onChange={(e) => props.onModelChange(`${selectedFamily}-${e.target.value}`)}
                                className={selectClassName}
                            >
                                {!selectedVariant ? <option value="" disabled>{t('newSession.model.default')}</option> : null}
                                {selectedVariant && !efforts.includes(selectedVariant.effort) ? (
                                    <option value={selectedVariant.effort} disabled>{CLAUDE_EFFORT_LABELS[selectedVariant.effort]}</option>
                                ) : null}
                                {efforts.map(effort => (
                                    <option key={effort} value={effort}>{CLAUDE_EFFORT_LABELS[effort]}</option>
                                ))}
                            </SelectControl>
                        </label>
                    ) : null}
                </div>
            )}
        </div>
    )
}
