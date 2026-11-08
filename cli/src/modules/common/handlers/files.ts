import { logger } from '@/ui/logger'
import { constants } from 'node:fs'
import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'crypto'
import { resolve } from 'path'
import { MEDIA_CHUNK_BYTES, type FileReadResponse, type GeneratedImageResponse, type ReadMediaRequest, type ReadMediaResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getGeneratedImage } from '../generatedImages'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ReadFileRequest {
    path: string
}

type ReadFileResponse = FileReadResponse

interface ReadGeneratedImageRequest {
    id: string
}

type ReadGeneratedImageResponse = GeneratedImageResponse

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

interface WriteFileResponse {
    success: boolean
    hash?: string
    error?: string
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.ReadFile, async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const resolvedPath = resolve(workingDirectory, data.path)
            const stats = await stat(resolvedPath)
            const buffer = await readFile(resolvedPath)
            const content = buffer.toString('base64')
            return {
                success: true,
                content,
                size: stats.size,
                modified: stats.mtime.getTime()
            }
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedImageRequest, ReadGeneratedImageResponse>(RPC_METHODS.ReadGeneratedImage, async (data) => {
        logger.debug('Read generated image request:', data.id)

        const image = getGeneratedImage(data.id)
        if (!image) {
            return rpcError('Generated image not found')
        }

        try {
            return {
                success: true,
                content: image.content.toString('base64'),
                mimeType: image.mimeType,
                fileName: image.fileName
            }
        } catch (error) {
            logger.debug('Failed to read generated image:', error)
            return rpcError(getErrorMessage(error, 'Failed to read generated image'))
        }
    })

    rpcHandlerManager.registerHandler<ReadMediaRequest, ReadMediaResponse>(RPC_METHODS.ReadMedia, async (data) => {
        const range = data.range
        if (range && (!Number.isSafeInteger(range.offset) || range.offset < 0 ||
            !Number.isInteger(range.length) || range.length < 1 || range.length > MEDIA_CHUNK_BYTES)) {
            return rpcError('Invalid media byte range')
        }
        const matches = (size: number, version: string) =>
            !range || (range.version === version && range.offset <= size - range.length)

        if ('generatedImageId' in data) {
            const image = getGeneratedImage(data.generatedImageId)
            if (!image) return rpcError('Generated media not found')
            const size = image.content.byteLength
            const version = `${image.id}:${image.createdAt}`
            if (!matches(size, version)) return rpcError('Generated media changed')
            const content = range
                ? image.content.subarray(range.offset, range.offset + range.length).toString('base64')
                : undefined
            return { success: true, size, version, mimeType: image.mimeType, content }
        }

        try {
            const validation = validatePath(data.path, workingDirectory)
            if (!validation.valid) return rpcError(validation.error ?? 'Invalid file path')
            const [root, path] = await Promise.all([
                realpath(workingDirectory), realpath(resolve(workingDirectory, data.path))
            ])
            if (!validatePath(path, root).valid) return rpcError('Media file is outside the working directory')

            const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
            try {
                const info = await handle.stat()
                if (!info.isFile()) return rpcError('Path is not a regular file')
                const { size } = info
                const version = `${info.dev}:${info.ino}:${size}:${info.mtimeMs}:${info.ctimeMs}`
                if (!matches(size, version)) return rpcError('Media file changed')
                if (!range) return { success: true, size, version }

                const bytes = Buffer.allocUnsafe(range.length)
                for (let offset = 0; offset < bytes.length;) {
                    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, range.offset + offset)
                    if (!bytesRead) return rpcError('Media file changed while reading')
                    offset += bytesRead
                }
                const current = await handle.stat()
                if (current.size !== size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) {
                    return rpcError('Media file changed while reading')
                }
                return { success: true, size, version, content: bytes.toString('base64') }
            } finally {
                await handle.close()
            }
        } catch (error) {
            return rpcError(getErrorMessage(error, 'Failed to read media'))
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>(RPC_METHODS.WriteFile, async (data) => {
        logger.debug('Write file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(data.path)
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex')

                    if (existingHash !== data.expectedHash) {
                        return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                    return rpcError('File does not exist but hash was provided')
                }
            } else {
                try {
                    await stat(data.path)
                    return rpcError('File already exists but was expected to be new')
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                }
            }

            const buffer = Buffer.from(data.content, 'base64')
            await writeFile(data.path, buffer)

            const hash = createHash('sha256').update(buffer).digest('hex')

            return { success: true, hash }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
