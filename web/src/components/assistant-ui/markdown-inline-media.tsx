import { useCallback, type ComponentPropsWithoutRef } from 'react'
import { useHappyChatContext, useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { InlineMediaPlayer } from '@/components/AssistantChat/messages/InlineMediaPlayer'
import { ImagePreview } from '@/components/ImagePreview'
import { parseCodexNativeSessionId } from '@/codex-native/session-key'
import { imageMediaCacheKey, useMediaSource } from '@/hooks/useMediaSource'
import { formatReadFileError } from '@/lib/files-i18n'
import { getInlineMediaMimeType, isInlineVideoMimeType } from '@/lib/generatedInlineMedia'
import { classifyNoSchemeHref } from '@/lib/markdown-href-policy'
import { decodeFilePathCandidateHref, decodeFilePathHref } from '@/lib/remark-file-path-links'
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
        nativeFiles: Boolean(parseCodexNativeSessionId(chat.sessionId) ?? chat.metadata?.nativeCodex),
    })
    if (path.action !== 'file') return null
    const mimeType = getInlineMediaMimeType(path.path)
    return mimeType ? { src: path.path, mimeType, local: true } : null
}

type PreviewProps = {
    source: MarkdownMediaSource
    label: string
    imageProps?: ComponentPropsWithoutRef<'img'>
    linkedImage?: boolean
    galleryId?: string
}

function MediaPreview({ src, mimeType, label, imageProps, linkedImage, galleryId, onError, sourceRevision }: Omit<PreviewProps, 'source'> & {
    src: string; mimeType: string; onError?: () => boolean; sourceRevision?: number
}) {
    const { t } = useTranslation()
    if (mimeType.startsWith('image/')) {
        if (linkedImage) {
            return <img key={sourceRevision} {...imageProps} src={src} alt={label} loading="lazy" referrerPolicy="no-referrer"
                onError={onError} className={cn('aui-md-img my-3 max-w-full rounded-xl', imageProps?.className)} />
        }
        const name = label || t('media.displayed.image')
        return <ImagePreview
            src={src}
            fileName={name}
            label={name}
            galleryId={galleryId}
            sourceRevision={sourceRevision}
            imageLoading="lazy"
            referrerPolicy="no-referrer"
            onError={onError}
            buttonClassName="my-3 block max-w-full cursor-zoom-in rounded-xl text-left"
            imageClassName={cn('aui-md-img max-w-full rounded-xl', imageProps?.className)}
        />
    }
    return <InlineMediaPlayer src={src} label={label} video={isInlineVideoMimeType(mimeType)} className="my-3"
        onError={onError} sourceRevision={sourceRevision} />
}

function LocalMediaPreview({ source, ...preview }: PreviewProps) {
    const { api, sessionId, metadata } = useHappyChatContext()
    const { t } = useTranslation()
    const { src, mimeType } = source
    const load = useCallback((signal: AbortSignal) => api.createSessionMediaUrl(sessionId, { path: src, mimeType }, signal),
        [api, sessionId, src, mimeType])
    const cacheKey = mimeType.startsWith('image/')
        ? imageMediaCacheKey(api, sessionId, { path: src, mimeType }, metadata?.nativeCodex)
        : undefined
    const { url, error, onPlaybackError, sourceRevision } = useMediaSource(load, cacheKey)

    if (url) return <MediaPreview {...preview} src={url} mimeType={mimeType} onError={onPlaybackError} sourceRevision={sourceRevision} />
    if (error !== undefined) return <span className="my-2 block text-sm text-[var(--app-hint)]" role="status">
        {preview.label ? `${preview.label} · ` : null}{formatReadFileError(error, t)}
    </span>
    return <span className="my-2 block text-sm text-[var(--app-hint)]" role="status">{t('media.preview.loading', { name: preview.label })}</span>
}

export function MarkdownMediaPreview({ source, ...preview }: Omit<PreviewProps, 'galleryId'>) {
    const chat = useOptionalHappyChatContext()
    const galleryId = chat ? `chat-media:${chat.sessionId}` : undefined
    if (source.local) return <LocalMediaPreview key={source.src} {...preview} source={source} galleryId={galleryId} />
    return <MediaPreview {...preview} src={source.src} mimeType={source.mimeType} galleryId={galleryId} />
}
