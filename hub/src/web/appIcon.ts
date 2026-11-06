import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_APP_ICON_BYTES = 1536 * 1024
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// The owner uploads only the canvas export, never the selected original file.
// Bound storage and require the expected PNG header and square dimensions.
export function normalizeAppIcon(input: Uint8Array): Buffer {
    const bytes = Buffer.from(input)
    if (bytes.length < 45 || bytes.length > MAX_APP_ICON_BYTES || !bytes.subarray(0, 8).equals(SIGNATURE)
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
        || bytes.readUInt32BE(16) !== 512 || bytes.readUInt32BE(20) !== 512) throw new Error('Expected a 512px PNG')
    return bytes
}

export class AppIconStore {
    private readonly path: string
    constructor(private readonly dataDir: string) { this.path = join(dataDir, 'app-icon.png') }

    async read(): Promise<{ bytes: Buffer; revision: string } | null> {
        try {
            const bytes = await readFile(this.path)
            return { bytes, revision: createHash('sha256').update(bytes).digest('hex').slice(0, 16) }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
        }
    }

    async replace(bytes: Buffer): Promise<void> {
        await mkdir(this.dataDir, { recursive: true })
        const temporary = `${this.path}.${randomUUID()}.tmp`
        try {
            await writeFile(temporary, bytes, { mode: 0o600 })
            await rename(temporary, this.path)
        } finally { await rm(temporary, { force: true }) }
    }

    async reset(): Promise<void> { await rm(this.path, { force: true }) }
}
