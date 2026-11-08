const MEDIA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp',
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    ogv: 'video/ogg',
    webm: 'video/webm',
}

export const INLINE_MEDIA_FILE_EXTENSIONS = Object.keys(MEDIA_MIME_BY_EXTENSION)

export function getInlineMediaMimeType(path: string): string | null {
    const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
    return extension && Object.hasOwn(MEDIA_MIME_BY_EXTENSION, extension)
        ? MEDIA_MIME_BY_EXTENSION[extension]
        : null
}

export function isInlineVideoMimeType(mimeType: string | null | undefined): boolean {
    return typeof mimeType === 'string' && mimeType.startsWith('video/')
}

export function isInlineAudioMimeType(mimeType: string | null | undefined): boolean {
    return typeof mimeType === 'string' && mimeType.startsWith('audio/')
}

export function isInlineImageMimeType(mimeType: string | null | undefined): boolean {
    return mimeType == null || mimeType.startsWith('image/')
}

export type InlineMediaLabelKey =
    | 'media.displayed.video'
    | 'media.displayed.audio'
    | 'media.displayed.image'
    | 'media.displayed.file'

export function inlineMediaLabelKey(mimeType: string | null | undefined): InlineMediaLabelKey {
    if (isInlineVideoMimeType(mimeType)) return 'media.displayed.video'
    if (isInlineAudioMimeType(mimeType)) return 'media.displayed.audio'
    if (isInlineImageMimeType(mimeType)) return 'media.displayed.image'
    return 'media.displayed.file'
}
