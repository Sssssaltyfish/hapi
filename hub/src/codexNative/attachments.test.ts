import { expect, test } from 'bun:test'
import { uploadAttachment, attachmentInputs, deleteAttachment } from './attachments'
import type { NativeService } from './service'
import { record, type NativeConnection } from './transport'

test('daemon-backed attachment references survive a fresh service and draft deletion preserves sent files', async () => {
    const files = new Map<string, string>(), directories = new Set(['/codex'])
    let copies = 0
    const client = {
        initialization: { codexHome: '/codex', platformFamily: 'unix' },
        async request(method: string, raw: unknown) {
            const params = record(raw), path = String(params.path)
            if (method === 'fs/getMetadata') {
                if (!files.has(path) && !directories.has(path)) throw new Error('No such file or directory (os error 2)')
                return { isFile: files.has(path), isDirectory: directories.has(path), isSymlink: false }
            }
            if (method === 'fs/createDirectory') directories.add(path)
            if (method === 'fs/writeFile') files.set(path, String(params.dataBase64))
            if (method === 'fs/copy') { copies++; files.set(String(params.destinationPath), files.get(String(params.sourcePath))!) }
            if (method === 'fs/remove') { expect(params.recursive).toBe(false); files.delete(path) }
            return {}
        }
    } as unknown as NativeConnection
    const freshService = () => ({ readThread: async () => ({ thread: { id: 'thread' } }), withConnection: async <T>(action: (client: NativeConnection) => Promise<T>) => action(client) }) as unknown as NativeService
    const config = { id: 'endpoint', label: 'Daemon', namespace: 'owner', endpoint: 'unix:///daemon' }
    const uploaded = await uploadAttachment(freshService(), config, 'thread', { filename: 'empty file.txt', mimeType: 'text/plain', dataBase64: '' })
    await expect(attachmentInputs(freshService(), config, 'another-thread', [uploaded.path])).rejects.toThrow('another thread')
    const input = await attachmentInputs(freshService(), config, 'thread', [uploaded.path])
    expect(input[0].type).toBe('text')
    expect(String(input[0].text)).toContain('/sent/')
    await attachmentInputs(freshService(), config, 'thread', [uploaded.path])
    expect(copies).toBe(1)
    await deleteAttachment(freshService(), config, 'thread', uploaded.path)
    expect([...files.keys()].every(path => path.includes('/sent/'))).toBe(true)
    expect([...files.values()]).toEqual([''])
    expect(await attachmentInputs(freshService(), config, 'thread', [uploaded.path])).toEqual(input)
    expect(copies).toBe(1)
    expect([...files.values()]).toEqual([''])
    const image = await uploadAttachment(freshService(), config, 'thread', { filename: 'image.png', mimeType: 'image/png', dataBase64: 'YWJj' })
    expect((await attachmentInputs(freshService(), config, 'thread', [image.path]))[0]).toMatchObject({ type: 'localImage' })
})
