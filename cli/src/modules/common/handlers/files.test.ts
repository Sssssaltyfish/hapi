import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'
import { MEDIA_CHUNK_BYTES, type ReadMediaRequest, type ReadMediaResponse } from '@hapi/protocol/apiTypes'

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('file RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-file-handler')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
    })

    it('returns file metadata alongside content', async () => {
        const filePath = join(rootDir, 'README.md')
        await writeFile(filePath, '# test')
        const expectedStats = await stat(filePath)

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'README.md' })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            content?: string
            size?: number
            modified?: number
        }

        expect(parsed.success).toBe(true)
        expect(parsed.content).toBe(Buffer.from('# test').toString('base64'))
        expect(parsed.size).toBe(expectedStats.size)
        expect(parsed.modified).toBe(expectedStats.mtime.getTime())
    })

    it('reads only the requested media range and rejects a stale file version', async () => {
        const file = join(rootDir, 'recording.wav')
        await writeFile(file, '0123456789')
        const read = async (data: ReadMediaRequest) => JSON.parse(await rpc.handleRequest({
            method: 'session-test:readMedia', params: JSON.stringify(data)
        })) as ReadMediaResponse
        const metadata = await read({ path: 'recording.wav' })
        expect(metadata).toMatchObject({ success: true, size: 10 })
        if (!metadata.success) throw new Error(metadata.error)
        expect(metadata.content).toBeUndefined()
        const range = { offset: 4, length: 3, version: metadata.version }
        expect(await read({ path: file, range })).toMatchObject({
            success: true, content: Buffer.from('456').toString('base64')
        })
        expect(await read({ path: file, range: { ...range, length: MEDIA_CHUNK_BYTES + 1 } }))
            .toMatchObject({ success: false })
        expect(await read({ path: '../recording.wav' })).toMatchObject({ success: false })
        await writeFile(file, 'replacement bytes')
        expect(await read({ path: file, range })).toMatchObject({ success: false })
    })
})
