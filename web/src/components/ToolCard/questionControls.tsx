import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

export function DismissQuestionButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
    const { t } = useTranslation()
    const label = t('tool.dismissQuestion')
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="-my-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:size-11"
        >
            <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="m6 6 12 12M6 18 18 6" />
            </svg>
        </button>
    )
}

export function QuestionAnswerInput({ className, ...props }: ComponentProps<'textarea'>) {
    return (
        <textarea
            rows={3}
            data-hapi-nested-scroll="true"
            {...props}
            className={cn(
                'block min-h-[88px] max-h-48 w-full resize-none overflow-y-auto border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] disabled:opacity-50 [field-sizing:content]',
                className
            )}
        />
    )
}
