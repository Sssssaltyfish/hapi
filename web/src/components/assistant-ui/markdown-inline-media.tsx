import { useCallback, type ComponentPropsWithoutRef } from 'react'
import { useHappyChatContext, useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { InlineMediaPlayer } from '@/components/AssistantChat/messages/InlineMediaPlayer'
import { useMediaSource } from '@/hooks/useMediaSource'
import { formatReadFileError } from '@/lib/files-i18n'
import { getInlineMediaMimeType, isInlineVideoMimeType } from '@/lib/generatedInlineMedia'
import { classifyNoSchemeHref } from '@/lib/markdown-href-policy'
import { decodeFilePathCandidateHref, decodeFilePathHref } from '@/lib/remark-file-path-links'
import { getMediaNativeIdentity, readSessionMediaBlob } from '@/lib/sessionMediaFile'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

export type MarkdownMediaSource = {
    src: string
    mimeType: string
    local: boolean
}

export function useMarkdownMediaSource(href: string | undefined, isImage: boolean): MarkdownMediaSource | null {
    const chat = useOptionalHappyChatContext()
    if (!href) return null
    if (/^(?:https?:)?\/\//i.test(href)) {
        let url: URL
        try {
            url = new URL(href.startsWith('//') ? `https:${href}` : href)
        } catch {
            return null
        }
        let path = url.pathname
        try {
            path = decodeURIComponent(path)
        } catch {
            // The original URL can still point to a valid remote file.
        }
        const mimeType = getInlineMediaMimeType(path) ?? (isImage ? 'image/*' : null)
        return mimeType ? { src: href, mimeType, local: false } : null
    }
    if (!chat) return null
    const candidatePath = decodeFilePathCandidateHref(href)
    if (candidatePath !== null && !/^[A-Za-z]:[\\/]/.test(candidatePath)) return null
    const fileHref = decodeFilePathHref(href) ?? candidatePath ?? href
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(fileHref) && !/^[A-Za-z]:(?:[\\/]|%5[cC])/.test(fileHref)) return null
    const path = classifyNoSchemeHref(fileHref, {
        workspacePath: chat.metadata?.path,
        nativeFiles: Boolean(getMediaNativeIdentity(chat.sessionId, chat.metadata?.nativeCodex)),
    })
    if (path.action !== 'file') return null
    const mimeType = getInlineMediaMimeType(path.path)
    return mimeType ? { src: path.path, mimeType, local: true } : null
}

type PreviewProps = { source: MarkdownMediaSource; label: string; imageProps?: ComponentPropsWithoutRef<'img'> }

function MediaPreview({ src, mimeType, label, imageProps, onError }: Omit<PreviewProps, 'source'> & {
    src: string; mimeType: string; onError?: () => boolean
}) {
    if (mimeType.startsWith('image/')) {
        return <img {...imageProps} src={src} alt={label} loading="lazy" referrerPolicy="no-referrer"
            className={cn('aui-md-img my-3 max-w-full rounded-xl', imageProps?.className)} />
    }
    return <InlineMediaPlayer src={src} label={label} video={isInlineVideoMimeType(mimeType)} className="my-3 block" onError={onError} />
}

function LocalMediaPreview({ source, label, imageProps }: PreviewProps) {
    const { api, sessionId, metadata } = useHappyChatContext()
    const { t } = useTranslation()
    const { src, mimeType } = source
    const { endpointId, threadId } = getMediaNativeIdentity(sessionId, metadata?.nativeCodex) ?? {}
    const load = useCallback((signal: AbortSignal) => mimeType.startsWith('image/')
        ? readSessionMediaBlob(api, sessionId, endpointId, threadId, src, mimeType, signal)
        : api.createSessionMediaUrl(sessionId, { path: src, mimeType }, signal),
    [api, sessionId, endpointId, threadId, src, mimeType])
    const { url, error, onPlaybackError } = useMediaSource(load)

    if (url) return <MediaPreview src={url} mimeType={mimeType} label={label} imageProps={imageProps} onError={onPlaybackError} />
    if (error !== undefined) return <span className="my-2 block text-sm text-[var(--app-hint)]" role="status">
        {label ? `${label} · ` : null}{formatReadFileError(error, t)}
    </span>
    return <span className="my-2 block text-sm text-[var(--app-hint)]" role="status">{t('media.preview.loading', { name: label })}</span>
}

export function MarkdownMediaPreview(props: PreviewProps) {
    if (props.source.local) return <LocalMediaPreview key={props.source.src} {...props} />
    return <MediaPreview src={props.source.src} mimeType={props.source.mimeType} label={props.label} imageProps={props.imageProps} />
}
