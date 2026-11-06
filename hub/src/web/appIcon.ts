import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_APP_ICON_BYTES = 1536 * 1024
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
export type AppIconType = 'image/png' | 'image/webp'
const mutations = new Map<string, Promise<void>>()

export function getAppIconType(bytes: Buffer): AppIconType {
    if (bytes.subarray(0, 8).equals(SIGNATURE)) return 'image/png'
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    throw new Error('Expected PNG or WebP')
}

async function mutate(path: string, action: () => Promise<void>): Promise<void> {
    const pending = (mutations.get(path) ?? Promise.resolve()).then(action)
    const settled = pending.catch(() => {})
    mutations.set(path, settled)
    try { await pending }
    finally { if (mutations.get(path) === settled) mutations.delete(path) }
}

// The owner uploads only the canvas export, never the selected original file.
// Safari may export PNG when Canvas WebP encoding is unavailable. Convert that
// cropped fallback on the hub; native WebP exports keep their existing encoding.
export async function normalizeAppIcon(input: Uint8Array): Promise<Buffer> {
    const bytes = Buffer.from(input)
    if (bytes.length > MAX_APP_ICON_BYTES) throw new Error('Image too large')
    const type = getAppIconType(bytes)
    const image = new Bun.Image(bytes, { maxPixels: 512 * 512 })
    const metadata = await image.metadata()
    if (metadata.width !== 512 || metadata.height !== 512) throw new Error('Expected a 512px square image')
    return type === 'image/webp' ? bytes : await image.webp({ quality: 80 }).buffer()
}

export class AppIconStore {
    private readonly path: string
    private readonly legacyPath: string
    constructor(private readonly dataDir: string) {
        this.path = join(dataDir, 'app-icon.webp')
        this.legacyPath = join(dataDir, 'app-icon.png')
    }

    async read(): Promise<{ bytes: Buffer; revision: string; type: AppIconType } | null> {
        try {
            const bytes = await readFile(this.path).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return readFile(this.legacyPath)
                throw error
            })
            return { bytes, type: getAppIconType(bytes), revision: createHash('sha256').update(bytes).digest('hex').slice(0, 16) }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
        }
    }

    async replace(bytes: Buffer): Promise<void> {
        await mutate(this.path, async () => {
            await mkdir(this.dataDir, { recursive: true })
            const temporary = `${this.path}.${randomUUID()}.tmp`
            try {
                await writeFile(temporary, bytes, { mode: 0o600 })
                await rename(temporary, this.path)
                await rm(this.legacyPath, { force: true })
            } finally { await rm(temporary, { force: true }) }
        })
    }

    async reset(): Promise<void> {
        await mutate(this.path, async () => {
            await rm(this.path, { force: true })
            await rm(this.legacyPath, { force: true })
        })
    }
}
