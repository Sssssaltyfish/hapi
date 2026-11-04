import { useRef, useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { MACHINE_DISPLAY_NAME_MAX_LENGTH } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'

/** Shared machine presentation; callers retain their own identity and rename API. */
export function MachineSettingsRow(props: {
    label: string
    displayName?: string
    fallbackName?: string
    platforms?: string[]
    address?: string
    status?: string
    onRename: (displayName: string) => Promise<unknown>
    onRenamed: () => void
    trailing?: ReactNode
    children?: ReactNode
}) {
    const { t } = useTranslation()
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState('')
    const [error, setError] = useState<string | null>(null)
    const saving = useRef(false)
    const rename = useMutation({
        mutationFn: props.onRename,
        onSuccess: () => {
            setEditing(false)
            setError(null)
            props.onRenamed()
        },
        onError: () => setError(t('settings.machines.error')),
    })
    function save() {
        if (saving.current) return
        const next = draft.trim()
        if (next === (props.displayName ?? props.label)) {
            setEditing(false)
            return
        }
        saving.current = true
        rename.mutate(next, {
            onSettled: () => {
                saving.current = false
            },
        })
    }

    return (
        <div role="group" aria-label={props.label} className="px-3 py-3">
            <div className="flex min-h-8 items-center gap-3">
                <div className="min-w-0 flex-1">
                    {editing ? (
                        <input
                            autoFocus
                            value={draft}
                            maxLength={MACHINE_DISPLAY_NAME_MAX_LENGTH}
                            disabled={rename.isPending}
                            placeholder={props.fallbackName ?? t('settings.machines.namePlaceholder')}
                            aria-label={t('settings.machines.rename', { name: props.label })}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={save}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault()
                                    save()
                                } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setEditing(false)
                                    setError(null)
                                }
                            }}
                            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)] disabled:opacity-60"
                        />
                    ) : (
                        <button
                            type="button"
                            onClick={() => {
                                setDraft(props.displayName ?? props.label)
                                setError(null)
                                setEditing(true)
                            }}
                            aria-label={t('settings.machines.rename', { name: props.label })}
                            className="block w-full truncate text-left text-sm font-medium text-[var(--app-fg)] hover:text-[var(--app-link)]"
                        >
                            {props.label}
                        </button>
                    )}
                </div>
                {props.status ? <span className="shrink-0 text-xs text-[var(--app-hint)]">{props.status}</span> : null}
                {props.trailing}
            </div>
            {props.platforms?.length ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--app-fg)]">
                    {props.platforms.map(platform => <span key={platform}>{platform}</span>)}
                </div>
            ) : null}
            {props.address ? <div className="mt-1 text-xs leading-snug text-[var(--app-hint)] [overflow-wrap:anywhere]">{props.address}</div> : null}
            {props.children}
            {error ? (
                <div role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div>
            ) : null}
        </div>
    )
}
