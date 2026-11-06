import { describe, expect, it, vi } from 'vitest'
import { exportIconCrop } from './app-icon'

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
