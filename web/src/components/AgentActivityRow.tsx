import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function AgentActivityRow({ icon, children, className, ...props }: ComponentProps<'div'> & { icon?: ReactNode }) {
    return (
        <div {...props} className={cn('flex min-w-0 items-start gap-2 px-2 py-0.5 text-left text-xs text-[var(--app-hint)]', className)}>
            <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 [overflow-wrap:anywhere]">{children}</div>
        </div>
    )
}
