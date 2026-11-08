export function base64FileBlob(base64Content: string, mimeType?: string | null): Blob {
    const byteChars = atob(base64Content)
    const bytes = new Uint8Array(byteChars.length)
    for (let index = 0; index < byteChars.length; index += 1) {
        bytes[index] = byteChars.charCodeAt(index)
    }

    return new Blob([bytes], { type: mimeType ?? 'application/octet-stream' })
}

export function downloadBase64File(fileName: string, base64Content: string, mimeType?: string | null): void {
    downloadFileBlob(fileName, base64FileBlob(base64Content, mimeType))
}

export function downloadFileBlob(fileName: string, blob: Blob): void {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
