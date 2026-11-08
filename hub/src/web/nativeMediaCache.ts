import { mkdtemp, open, rm, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaConfig } from '../config/media'

// Keep decoder memory independent of file size. Base64 slices need to start at a multiple of four.
const BASE64_BLOCK_CHARS = 1024 * 1024

type Snapshot = {
    handle: FileHandle
    dispose(): Promise<void>
}

type Entry = Snapshot & {
    size: number
    readers: number
    retired: boolean
    timer?: ReturnType<typeof setTimeout>
}

export class NativeMediaCacheError extends Error {
    constructor(readonly status: 413 | 503, message: string) {
        super(message)
    }
}

async function openSnapshot(): Promise<Snapshot> {
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
        return { handle, dispose }
    } catch (error) {
        await dispose()
        throw error
    }
}

async function writeSnapshot(handle: FileHandle, encoded: string, size: number): Promise<void> {
    let position = 0
    for (let offset = 0; offset < encoded.length; offset += BASE64_BLOCK_CHARS) {
        const block = Buffer.from(encoded.slice(offset, offset + BASE64_BLOCK_CHARS), 'base64')
        if (block.length > size - position) throw new Error('Invalid native media payload')
        for (let written = 0; written < block.length;) {
            const { bytesWritten } = await handle.write(block, written, block.length - written, position + written)
            if (!bytesWritten) throw new Error('Could not write the media snapshot')
            written += bytesWritten
        }
        position += block.length
    }
    if (position !== size) throw new Error('Invalid native media payload')
}

/** Native `fs/readFile` returns one base64 payload. Keep completed imports on disk. */
export class NativeMediaCache {
    private readonly entries = new Map<string, Entry>()
    private readonly pending = new Map<string, Promise<Entry>>()
    private readonly waiting: Array<() => void> = []
    private activeImports = 0
    // Reservations include writes in progress and retired snapshots until the last
    // reader releases them and the file handle has actually been closed.
    private bytes = 0
    private slots = 0

    constructor(private readonly config: MediaConfig) {}

    private async dispose(snapshot: Snapshot | undefined, size: number): Promise<void> {
        try {
            await snapshot?.dispose()
            this.bytes -= size
            this.slots -= 1
        } catch (error) {
            // Keep the reservation charged if the snapshot may still be on disk.
            console.error('[Media] Could not remove native media snapshot', error)
        }
    }

    private async retire(key: string, entry: Entry): Promise<void> {
        if (this.entries.get(key) !== entry) return
        this.entries.delete(key)
        entry.retired = true
        clearTimeout(entry.timer)
        if (!entry.readers) await this.dispose(entry, entry.size)
    }

    private async reserve(size: number): Promise<void> {
        const { nativeCacheMaxBytes, nativeCacheMaxEntries } = this.config
        if (size > nativeCacheMaxBytes) {
            throw new NativeMediaCacheError(413, 'Media exceeds the native cache capacity')
        }
        while (size > nativeCacheMaxBytes - this.bytes || this.slots >= nativeCacheMaxEntries) {
            const idle = Array.from(this.entries).find(([key, entry]) => !entry.readers && !this.pending.has(key))
            if (!idle) throw new NativeMediaCacheError(503, 'Native media cache is busy')
            await this.retire(...idle)
        }
        this.bytes += size
        this.slots += 1
    }

    private schedule(load: () => Promise<Entry>): Promise<Entry> {
        const { nativeMaxConcurrentImports, nativeMaxPendingImports } = this.config
        if (this.activeImports >= nativeMaxConcurrentImports && this.waiting.length >= nativeMaxPendingImports) {
            throw new NativeMediaCacheError(503, 'Native media imports are busy')
        }
        return new Promise((resolve, reject) => {
            const start = () => {
                this.activeImports += 1
                void load().finally(() => {
                    this.activeImports -= 1
                    this.waiting.shift()?.()
                }).then(resolve, reject)
            }
            if (this.activeImports < nativeMaxConcurrentImports) start()
            else this.waiting.push(start)
        })
    }

    private async import(key: string, load: () => Promise<string>): Promise<Entry> {
        const encoded = await load()
        if (encoded.length % 4 !== 0) throw new Error('Invalid native media payload')
        const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
        const size = encoded.length / 4 * 3 - padding
        await this.reserve(size)
        let snapshot: Snapshot | undefined
        try {
            snapshot = await openSnapshot()
            await writeSnapshot(snapshot.handle, encoded, size)
            const entry: Entry = { ...snapshot, size, readers: 0, retired: false }
            this.entries.set(key, entry)
            return entry
        } catch (error) {
            await this.dispose(snapshot, size)
            throw error
        }
    }

    async acquire(key: string, load: () => Promise<string>) {
        let entry = this.entries.get(key)
        if (!entry) {
            let pending = this.pending.get(key)
            if (!pending) {
                pending = this.schedule(() => this.import(key, load))
                this.pending.set(key, pending)
            }
            try { entry = await pending } finally {
                if (this.pending.get(key) === pending) this.pending.delete(key)
            }
        }

        const snapshot = entry
        this.entries.delete(key)
        this.entries.set(key, snapshot)
        clearTimeout(snapshot.timer)
        snapshot.timer = setTimeout(() => void this.retire(key, snapshot), this.config.nativeCacheTtlSeconds * 1000)
        snapshot.timer.unref()
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
                if (!snapshot.readers && snapshot.retired) return this.dispose(snapshot, snapshot.size)
                return undefined
            }
        }
    }
}
