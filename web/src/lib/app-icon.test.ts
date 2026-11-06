import { describe, expect, it, vi } from 'vitest'
import { exportIconCrop, refreshAppManifest } from './app-icon'

describe('app icon export', () => {
    it.each(['image/webp', 'image/png'])('requests compressed WebP and preserves the actual %s output type', async (type) => {
        const blob = new Blob(['cropped image'], { type })
        const toBlob = vi.fn((callback: BlobCallback) => callback(blob))
        const output = await exportIconCrop({ toBlob } as unknown as HTMLCanvasElement)
        expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.8)
        expect(output).toBe(blob)
        expect(output.type).toBe(type)
    })

    it('rejects failed exports', async () => {
        const toBlob = (callback: BlobCallback) => callback(null)
        await expect(exportIconCrop({ toBlob } as HTMLCanvasElement)).rejects.toThrow('Could not export icon')
    })
})

describe('dynamic app manifest', () => {
    it('changes the existing manifest URL per icon revision while preserving its base and parameters', () => {
        document.head.innerHTML = '<link rel="manifest" href="/hapi/manifest.webmanifest?tenant=one">'
        refreshAppManifest(`${location.origin}/api/app-icon/image`, 'crop-2')
        const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!
        const url = new URL(link.href)
        expect(url.pathname).toBe('/hapi/manifest.webmanifest')
        expect(url.searchParams.get('tenant')).toBe('one')
        expect(url.searchParams.get('app-icon')).toBe('crop-2')
        refreshAppManifest(`${location.origin}/api/app-icon/image`, null)
        expect(new URL(link.href).searchParams.get('app-icon')).toBe('default')
    })

    it('preserves the hosting manifest when connected to another Hub', () => {
        document.head.innerHTML = '<link rel="manifest" href="/manifest.webmanifest">'
        const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!
        const original = link.href
        refreshAppManifest('https://another-hub.example/api/app-icon/image', 'crop-2')
        expect(link.href).toBe(original)
    })
})
