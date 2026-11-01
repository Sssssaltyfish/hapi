import { useSyncExternalStore, type ReactNode } from 'react'
import type { WorkGroup } from '@/lib/work-groups'
import { useOptionalWorkExpansionState } from '@/components/AssistantChat/context'
import { useTranslation } from '@/lib/use-translation'

const subscribeNothing = () => () => {}

export function WorkDisclosure({ work, children }: { work: WorkGroup; children: ReactNode }) {
    const expansion = useOptionalWorkExpansionState()
    const { t } = useTranslation()
    const choice = useSyncExternalStore(expansion?.subscribe ?? subscribeNothing,
        () => expansion?.get(work.turnId),
        () => undefined)
    const open = work.blocked || (choice ?? !work.canCollapse)
    return (
        <details data-hapi-work-turn={work.turnId} open={open} className="min-w-0">
            <summary className="mb-2 cursor-pointer text-xs text-[var(--app-hint)]"
                onClick={event => {
                    event.preventDefault()
                    if (!work.blocked) expansion?.set(work.turnId, !open)
                }}>
                {t(work.active ? 'session.work.running' : 'session.work.completed')}
            </summary>
            <div className="min-w-0">{children}</div>
        </details>
    )
}
