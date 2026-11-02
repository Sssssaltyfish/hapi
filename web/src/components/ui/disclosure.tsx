import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function DisclosureChevron(props: { open: boolean; className?: string }) {
    return <svg
        aria-hidden="true"
        className={cn('h-4 w-4 shrink-0 transition-transform duration-250 ease-in-out motion-reduce:transition-none', props.open && 'rotate-90', props.className)}
        viewBox="0 0 16 16"
        fill="none"
        data-state={props.open ? 'open' : 'closed'}
    >
        <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
}

/** Defer expensive first content, and retain it until the actual close finishes. */
export function DisclosureContent(props: {
    open: boolean
    id: string
    children: ReactNode | (() => ReactNode)
    keepMounted?: boolean
    className?: string
}) {
    const panel = useRef<HTMLDivElement>(null)
    const deferredOpen = useDeferredValue(props.open)
    const [present, setPresent] = useState(props.open || props.keepMounted === true)
    const [expanded, setExpanded] = useState(props.open)
    const ready = props.open && deferredOpen
    if ((ready || props.keepMounted) && !present) setPresent(true)

    useLayoutEffect(() => {
        if (ready === expanded) return
        // Newly rendered content first gets a real closed grid baseline. The
        // subsequent commit animates its full height instead of an empty panel.
        if (ready) panel.current?.getBoundingClientRect()
        setExpanded(ready)
    }, [ready, expanded])

    useEffect(() => {
        if (props.open || expanded || !present || props.keepMounted) return
        const animations = panel.current?.getAnimations?.() ?? []
        if (!animations.length) {
            setPresent(false)
            return
        }
        let cancelled = false
        void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
            if (!cancelled) setPresent(false)
        })
        return () => { cancelled = true }
    }, [props.open, props.keepMounted, expanded, present])

    return <div
        ref={panel}
        id={props.id}
        className={cn('collapsible-panel hapi-disclosure-content', props.className)}
        data-open={expanded ? '' : undefined}
        aria-hidden={!expanded}
        aria-busy={props.open && !expanded || undefined}
        inert={!expanded}
    >
        <div className="min-h-0 overflow-hidden">
            {present ? typeof props.children === 'function' ? props.children() : props.children : null}
        </div>
    </div>
}
