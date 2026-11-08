import { mkdtemp, open, rm, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CACHE_BYTES = 256 * 1024 * 1024
const CACHE_ENTRIES = 16
const MAX_PENDING_IMPORTS = 8
// Keep decoder memory independent of file size. Base64 slices need to start at a multiple of four.
const BASE64_BLOCK_CHARS = 1024 * 1024

type Snapshot = {
    size: number
    handle: FileHandle
    dispose(): Promise<void>
}

type Entry = Snapshot & {
    readers: number
    retired: boolean
    timer: ReturnType<typeof setTimeout>
}

async function writeSnapshot(encoded: string): Promise<Snapshot> {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-media-'))
    const path = join(dir, 'media')
    let handle: FileHandle | undefined
    let unlinked = false
    const dispose = async () => {
        try { await handle?.close() } finally {
            if (!unlinked) {
                await rm(path, { force: true })
                await rmdir(dir)
            }
        }
    }
    try {
        handle = await open(path, 'wx+', 0o600)
        // On Unix the open descriptor keeps the snapshot readable after unlink. This
        // also cleans up if the Hub exits abruptly. Windows can keep the private path
        // until the last reader closes if it won't let us unlink an open file.
        if (process.platform !== 'win32') {
            await unlink(path)
            await rmdir(dir)
            unlinked = true
        }
        let size = 0
        for (let offset = 0; offset < encoded.length; offset += BASE64_BLOCK_CHARS) {
            const block = Buffer.from(encoded.slice(offset, offset + BASE64_BLOCK_CHARS), 'base64')
            for (let written = 0; written < block.length;) {
                const { bytesWritten } = await handle.write(block, written, block.length - written, size + written)
                if (!bytesWritten) throw new Error('Could not write the media snapshot')
                written += bytesWritten
            }
            size += block.length
        }
        return { size, handle, dispose }
    } catch (error) {
        await dispose()
        throw error
    }
}

/** Native `fs/readFile` returns one base64 payload. Keep completed imports on disk. */
export class NativeMediaCache {
    private readonly entries = new Map<string, Entry>()
    private readonly pending = new Map<string, Promise<Entry>>()
    private imports: Promise<unknown> = Promise.resolve()
    private bytes = 0
    private activeBytes = 0
    private activeEntries = 0

    private retire(key: string, entry: Entry): void {
        this.entries.delete(key)
        this.bytes -= entry.size
        entry.retired = true
        clearTimeout(entry.timer)
        if (!entry.readers) void entry.dispose().catch(console.error)
    }

    private trim(keep: Entry): void {
        for (const [key, entry] of this.entries) {
            if (this.bytes <= CACHE_BYTES && this.entries.size <= CACHE_ENTRIES) return
            if (entry !== keep && !entry.readers) this.retire(key, entry)
        }
    }

    async acquire(key: string, expiresAt: number, load: () => Promise<string>) {
        let entry = this.entries.get(key)
        if (!entry) {
            let pending = this.pending.get(key)
            if (!pending) {
                if (this.pending.size >= MAX_PENDING_IMPORTS) throw new Error('Native media imports are busy')
                pending = this.imports.then(async () => {
                    if (expiresAt <= Date.now()) throw new Error('Media ticket expired')
                    // A single large media file can exceed the idle cache budget.
                    // Defer additional imports while existing readers pin that space.
                    if (this.activeBytes >= CACHE_BYTES || this.activeEntries >= CACHE_ENTRIES) {
                        throw new Error('Native media imports are busy')
                    }
                    const snapshot = await writeSnapshot(await load())
                    const record: Entry = {
                        ...snapshot, readers: 0, retired: false,
                        timer: setTimeout(() => this.retire(key, record), Math.max(0, expiresAt - Date.now()))
                    }
                    record.timer.unref()
                    this.bytes += record.size
                    this.entries.set(key, record)
                    this.trim(record)
                    return record
                }).finally(() => this.pending.delete(key))
                this.pending.set(key, pending)
                this.imports = pending.catch(() => {})
            }
            entry = await pending
        }
        if (entry.retired) throw new Error('Media snapshot expired')
        const snapshot = entry
        this.entries.delete(key)
        this.entries.set(key, snapshot)
        if (!snapshot.readers) {
            this.activeBytes += snapshot.size
            this.activeEntries += 1
        }
        snapshot.readers += 1
        let released = false
        return {
            size: snapshot.size,
            async read(offset: number, length: number) {
                const bytes = Buffer.allocUnsafe(length)
                for (let written = 0; written < length;) {
                    const { bytesRead } = await snapshot.handle.read(bytes, written, length - written, offset + written)
                    if (!bytesRead) throw new Error('Could not read the media snapshot')
                    written += bytesRead
                }
                return bytes
            },
            release: () => {
                if (released) return
                released = true
                snapshot.readers -= 1
                if (!snapshot.readers) {
                    this.activeBytes -= snapshot.size
                    this.activeEntries -= 1
                    if (snapshot.retired) void snapshot.dispose().catch(console.error)
                    else this.trim(snapshot)
                }
            }
        }
    }
}
