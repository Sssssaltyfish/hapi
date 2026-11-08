import { useState, type SyntheticEvent } from 'react'
import { cn } from '@/lib/utils'

export function InlineMediaPlayer(props: {
    src: string; video: boolean; label: string; className?: string; onError?: () => boolean
}) {
    const [resume, setResume] = useState<{ source: string; time: number; play: boolean } | null>(null)
    const renewed = resume !== null && resume.source !== props.src

    function handleError({ currentTarget: player }: SyntheticEvent<HTMLMediaElement>) {
        if (props.onError?.()) {
            setResume({ source: props.src, time: player.currentTime, play: !player.paused && !player.ended })
        }
    }

    function handleLoadedMetadata({ currentTarget: player }: SyntheticEvent<HTMLMediaElement>) {
        if (!renewed || !resume) return
        setResume(null)
        player.currentTime = Number.isFinite(player.duration) ? Math.min(resume.time, player.duration) : resume.time
        if (resume.play) void player.play().catch(() => undefined)
    }

    const mediaProps = {
        src: props.src,
        controls: true,
        preload: renewed ? 'metadata' : 'none',
        'aria-label': props.label,
        'data-hapi-share-exclude': 'true',
        onError: handleError,
        onLoadedMetadata: handleLoadedMetadata,
    } as const

    return props.video
        ? <video {...mediaProps} playsInline
            className={cn('max-h-[min(28rem,60vh)] max-w-full rounded-xl', props.className)} />
        : <audio {...mediaProps}
            className={cn('w-80 max-w-full', props.className)} />
}
