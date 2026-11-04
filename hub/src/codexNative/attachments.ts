import { createHash, randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { NativeEndpointConfig } from './registry'
import type { NativeService } from './service'
import { record, type NativeConnection, type NativeRecord } from './transport'

const Descriptor = z
    .object({
        scope: z.string(),
        uuid: z.uuid(),
        filename: z
            .string()
            .min(1)
            .refine((value) => value !== '.' && value !== '..' && !/[\\/\x00-\x1f]/.test(value)),
        mimeType: z.string().refine((value) => !/[\r\n]/.test(value)),
    })
    .strict()
type Descriptor = z.infer<typeof Descriptor>
const prefix = 'native-attachment:'
function scope(config: NativeEndpointConfig, threadId: string) {
    return createHash('sha256')
        .update(JSON.stringify([config.namespace, config.id, config.endpoint, threadId]))
        .digest('hex')
}
function parse(path: string, expected: string): Descriptor {
    if (!path.startsWith(prefix)) throw new Error('Invalid native attachment reference')
    const descriptor = Descriptor.parse(
        JSON.parse(Buffer.from(path.slice(prefix.length), 'base64url').toString('utf8'))
    )
    if (descriptor.scope !== expected)
        throw new Error('Native attachment belongs to another thread or endpoint')
    return descriptor
}
function paths(client: NativeConnection, descriptor: Descriptor, kind: 'staging' | 'sent') {
    const home = client.initialization.codexHome
    if (typeof home !== 'string') throw new Error('Daemon did not advertise codexHome')
    const path = client.initialization.platformFamily === 'windows' ? win32 : posix
    const root = path.join(home, 'attachments', 'hapi', descriptor.scope, kind)
    const directory = path.join(root, descriptor.uuid)
    return { path, home, directory, file: path.join(directory, descriptor.filename) }
}
async function directory(
    client: NativeConnection,
    descriptor: Descriptor,
    kind: 'staging' | 'sent',
    create: boolean
) {
    const target = paths(client, descriptor, kind)
    const relative = target.path.relative(target.home, target.directory).split(target.path.sep)
    let current = target.home
    for (const part of ['', ...relative]) {
        if (part) current = target.path.join(current, part)
        let metadata: NativeRecord
        try {
            metadata = record(await client.request('fs/getMetadata', { path: current }))
        } catch (error) {
            if (!create || !/not found|no such file|cannot find|os error 2/i.test(String(error)))
                throw error
            await client.request('fs/createDirectory', { path: current, recursive: false })
            metadata = record(await client.request('fs/getMetadata', { path: current }))
        }
        if (metadata.isSymlink || !metadata.isDirectory)
            throw new Error('Invalid native attachment directory')
    }
    return target
}
async function regularFile(client: NativeConnection, path: string) {
    const metadata = record(await client.request('fs/getMetadata', { path }))
    if (metadata.isSymlink || !metadata.isFile)
        throw new Error('Native attachment is not a regular file')
}
export async function uploadAttachment(
    service: NativeService,
    config: NativeEndpointConfig,
    threadId: string,
    file: { filename: string; mimeType: string; dataBase64: string }
) {
    await service.readThread(threadId)
    const descriptor = Descriptor.parse({
        scope: scope(config, threadId),
        uuid: randomUUID(),
        filename: file.filename.replace(/[\\/\x00-\x1f]/g, '_'),
        mimeType: file.mimeType,
    })
    return service.withConnection(async (client) => {
        const target = await directory(client, descriptor, 'staging', true)
        await client.request('fs/writeFile', { path: target.file, dataBase64: file.dataBase64 })
        await regularFile(client, target.file)
        return {
            success: true,
            path: prefix + Buffer.from(JSON.stringify(descriptor)).toString('base64url'),
        }
    })
}
export async function deleteAttachment(
    service: NativeService,
    config: NativeEndpointConfig,
    threadId: string,
    path: string
) {
    const descriptor = parse(path, scope(config, threadId))
    return service.withConnection(async (client) => {
        const target = await directory(client, descriptor, 'staging', false)
        await regularFile(client, target.file)
        await client.request('fs/remove', { path: target.file, recursive: false, force: false })
        return { success: true }
    })
}
export async function attachmentInputs(
    service: NativeService,
    config: NativeEndpointConfig,
    threadId: string,
    references: string[]
): Promise<NativeRecord[]> {
    const descriptors = references.map((reference) => parse(reference, scope(config, threadId)))
    if (!descriptors.length) return []
    return service.withConnection(async (client) => {
        const input: NativeRecord[] = []
        for (const descriptor of descriptors) {
            const target = await directory(client, descriptor, 'sent', true)
            let exists = true
            try {
                await client.request('fs/getMetadata', { path: target.file })
            } catch (error) {
                if (!/not found|no such file|cannot find|os error 2/i.test(String(error)))
                    throw error
                exists = false
            }
            if (!exists) {
                const source = await directory(client, descriptor, 'staging', false)
                await regularFile(client, source.file)
                await client.request('fs/copy', {
                    sourcePath: source.file,
                    destinationPath: target.file,
                    recursive: false,
                })
            }
            await regularFile(client, target.file)
            input.push(
                descriptor.mimeType.startsWith('image/')
                    ? { type: 'localImage', path: target.file }
                    : {
                          type: 'text',
                          text: `File ${JSON.stringify(descriptor.filename)}: ${JSON.stringify(target.file)}`,
                          text_elements: [],
                      }
            )
        }
        return input
    })
}
