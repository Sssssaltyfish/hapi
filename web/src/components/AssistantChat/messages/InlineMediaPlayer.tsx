import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { ExpandIcon } from '@/components/icons'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

type PlayerProps = {
    src: string; video: boolean; label: string; className?: string; onError?: () => boolean
    sourceRevision?: number
}
type PlaybackPosition = { time: number; play: boolean }

function MediaControls(props: PlayerProps & {
    mediaRef: (element: HTMLMediaElement | null) => void
    start?: PlaybackPosition | null
}) {
    const initial = useRef(props.start)
    const media = useRef<HTMLMediaElement | null>(null)
    const [resume, setResume] = useState<(PlaybackPosition & { source: string; revision?: number }) | null>(null)
    const renewed = resume !== null && (resume.source !== props.src || resume.revision !== props.sourceRevision)

    useEffect(() => {
        // A stable URL can be renewed without changing the src attribute.
        if (renewed && resume.source === props.src) media.current?.load()
    }, [renewed, resume, props.src])

    function handleError({ currentTarget: player }: SyntheticEvent<HTMLMediaElement>) {
        if (props.onError?.()) {
            setResume({
                source: props.src, revision: props.sourceRevision,
                time: player.currentTime, play: !player.paused && !player.ended,
            })
        }
    }

    function handleLoadedMetadata({ currentTarget: player }: SyntheticEvent<HTMLMediaElement>) {
        const position = renewed ? resume : initial.current
        if (!position) return
        initial.current = null
        setResume(null)
        player.currentTime = Number.isFinite(player.duration) ? Math.min(position.time, player.duration) : position.time
        if (position.play) void player.play().catch(() => undefined)
    }

    const mediaProps = {
        src: props.src,
        controls: true,
        preload: renewed || props.start?.play || (props.start?.time ?? 0) > 0 ? 'metadata' : 'none',
        'aria-label': props.label,
        ref: (element: HTMLMediaElement | null) => {
            media.current = element
            props.mediaRef(element)
        },
        onError: handleError,
        onLoadedMetadata: handleLoadedMetadata,
    } as const

    return props.video
        ? <video {...mediaProps} playsInline
            className={cn('max-h-[min(28rem,60vh)] max-w-full rounded-xl', props.className)} />
        : <audio {...mediaProps}
            className={cn('w-80 max-w-full', props.className)} />
}

function stopEvent(event: SyntheticEvent) {
    event.stopPropagation()
}

export function InlineMediaPlayer(props: PlayerProps) {
    const { t } = useTranslation()
    const inline = useRef<HTMLMediaElement | null>(null)
    const expanded = useRef<HTMLMediaElement | null>(null)
    const trigger = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [start, setStart] = useState<PlaybackPosition | null>(null)
    const previewLabel = t('media.preview.open', { name: props.label })

    function onOpenChange(next: boolean) {
        if (next && inline.current) {
            const player = inline.current
            setStart({ time: player.currentTime, play: !player.paused && !player.ended })
            if (!player.paused) player.pause()
        } else if (!next && expanded.current) {
            const player = expanded.current
            if (!player.paused) player.pause()
            if (inline.current && player.readyState >= 1) inline.current.currentTime = player.currentTime
        }
        setOpen(next)
    }

    return <span className={cn('flex w-fit min-w-0 max-w-full items-center gap-1', props.className)} data-hapi-share-exclude="true">
        <MediaControls {...props} className="min-w-0" mediaRef={element => { inline.current = element }} />
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogTrigger asChild>
                <button ref={trigger} type="button" aria-label={previewLabel} title={previewLabel}
                    onPointerDown={stopEvent} onClick={stopEvent}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                    <ExpandIcon />
                </button>
            </DialogTrigger>
            <DialogContent
                aria-modal="true"
                aria-describedby={undefined}
                className={cn('max-h-[calc(100dvh-24px)] overflow-auto overscroll-contain', props.video && 'max-w-4xl')}
                overlayProps={{ onPointerDown: stopEvent, onClick: stopEvent }}
                onPointerDownOutside={event => event.preventDefault()}
                onPointerDown={stopEvent}
                onClick={stopEvent}
                onCloseAutoFocus={event => {
                    event.preventDefault()
                    trigger.current?.focus({ preventScroll: true })
                }}
            >
                <DialogHeader><DialogTitle>{props.label}</DialogTitle></DialogHeader>
                <div className="mt-3">
                    <MediaControls {...props} start={start} mediaRef={element => { expanded.current = element }}
                        className={props.video ? 'mx-auto max-h-[min(70dvh,48rem)]' : 'w-full'} />
                </div>
            </DialogContent>
        </Dialog>
    </span>
}
