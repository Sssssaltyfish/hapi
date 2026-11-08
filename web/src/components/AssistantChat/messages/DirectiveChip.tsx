import { SparklesIcon } from '@/components/ToolCard/icons'

export function formatDirectiveLabel(value: string): string {
    return value
        .replace(/^[$/]/, '')
        .replace(/[_-]+/g, ' ')
        .trim()
}

export function DirectiveChip(props: { value: string }) {
    return (
        <span
            className="inline-flex items-center justify-center gap-[0.2rem] whitespace-nowrap rounded-full border-0 bg-[var(--app-chat-user-chip-bg)] px-2 py-px align-middle text-[length:var(--app-chat-font-size)] font-normal leading-[1.4] text-[var(--app-chat-user-chip-fg)] shadow-none"
            title={props.value}
            aria-label={props.value}
        >
            <SparklesIcon className="h-[0.92em] w-[0.92em] shrink-0 [stroke-width:1.6]" />
            <span>{formatDirectiveLabel(props.value)}</span>
        </span>
    )
}
