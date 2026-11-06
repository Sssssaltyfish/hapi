export type IconCrop = { x: number; y: number; zoom: number }

export function drawIconCrop(canvas: HTMLCanvasElement, image: HTMLImageElement, crop: IconCrop): void {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    const side = Math.min(image.naturalWidth, image.naturalHeight) / crop.zoom
    canvas.width = 512
    canvas.height = 512
    context.clearRect(0, 0, 512, 512)
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, (image.naturalWidth - side) * crop.x, (image.naturalHeight - side) * crop.y, side, side, 0, 0, 512, 512)
}

export function exportIconCrop(canvas: HTMLCanvasElement): Promise<Blob> {
    // Some browsers (including Safari) fall back to PNG when WebP encoding is
    // unavailable. Preserve its real MIME type; the hub converts that crop.
    return new Promise((resolve, reject) => canvas.toBlob((blob) => {
        if (blob && (blob.type === 'image/webp' || blob.type === 'image/png')) resolve(blob)
        else reject(new Error('Could not export icon'))
    }, 'image/webp', 0.8))
}

export function refreshAppIconLinks(url: string, type?: string | null, appleTouchUrl = url): void {
    document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
        link.href = link.rel === 'apple-touch-icon' ? appleTouchUrl : url
        if (link.rel === 'apple-touch-icon') link.type = 'image/png'
        else if (type) link.type = type
        else link.removeAttribute('type')
    })
}
