import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NativeEndpointConfig } from './registry'
import type { NativeService } from './service'
import { record, text } from './transport'

/** Resolve links using the thread's path syntax; the selected daemon owns file access. */
export async function nativeFilePath(
    service: NativeService,
    config: NativeEndpointConfig,
    threadId: string,
    requested: string
) {
    const response = record(await service.readThread(threadId)),
        thread = record(response.thread)
    const cwd = text(thread.cwd)
    if (!cwd) throw new Error('Native thread has no workspace root')
    const paths = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? win32 : posix
    if (requested.includes('\0') || requested.length > 4096) throw new Error('Invalid file path')
    let target = requested
    if (/^file:/i.test(target)) {
        try {
            target = fileURLToPath(target, { windows: paths === win32 })
        } catch {
            throw new Error('Invalid file path')
        }
    }
    // Markdown absolute hrefs can add a URL root before a Windows drive.
    // Only strip it for Windows daemons: /C:/... is a valid POSIX path.
    if (paths === win32 && /^\/[A-Za-z]:[\\/]/.test(target)) target = target.slice(1)
    if (target.includes('\0')) throw new Error('Invalid file path')
    const path = paths.resolve(cwd, target)
    if (config.fileAccess !== 'host') {
        const compare = (value: string) => (paths === win32 ? value.toLowerCase() : value)
        const roots = [cwd, ...(config.allowedRoots ?? [])].map((root) => paths.resolve(root))
        const root = roots.find((root) => {
            const relative = paths.relative(compare(root), compare(path))
            return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative))
        })
        if (!root) throw new Error('File path is outside the native thread workspace')
        const relative = paths.relative(root, path),
            components = relative ? relative.split(paths.sep) : []
        if (components.length > 64) throw new Error('File path is too deep')
        const candidates = [root, ...components.map((_, index) => paths.join(root, ...components.slice(0, index + 1)))]
        let metadata = {}
        for (let offset = 0; offset < candidates.length; offset += 4) {
            const entries = await Promise.all(candidates.slice(offset, offset + 4).map(async (candidate) => {
                const entry = record(await service.call('fs/getMetadata', { path: candidate }))
                if (entry.isSymlink === true) throw new Error('Symbolic links are not supported by the native file viewer')
                return entry
            }))
            metadata = entries[entries.length - 1]
        }
        return { path, metadata: record(metadata) }
    }
    const metadata = record(await service.call('fs/getMetadata', { path }))
    return { path, metadata }
}
