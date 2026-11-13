import { useTranslation } from '@/lib/use-translation'

export function ModelCatalogRefresh(props: { onRefresh: () => void; isFetching?: boolean }) {
    const { t } = useTranslation()
    const label = props.isFetching ? t('newSession.agyModel.fetchingModels') : t('common.refresh')

    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-busy={props.isFetching}
            disabled={props.isFetching}
            onClick={props.onRefresh}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-text)] disabled:opacity-50"
        >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4${props.isFetching ? ' animate-spin' : ''}`} aria-hidden="true">
                <path d="M20 7v5h-5M4 17v-5h5" />
                <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
            </svg>
        </button>
    )
}
