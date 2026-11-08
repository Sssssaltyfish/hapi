import { expect, it } from 'bun:test'
import { resolveMediaConfig } from '../config/media'
import { NativeMediaCache } from './nativeMediaCache'

const bytes = (size: number) => async () => Buffer.alloc(size, 'x').toString('base64')

it('reserves bytes before concurrent imports write and rejects a file larger than the total capacity', async () => {
    const cache = new NativeMediaCache(resolveMediaConfig({ nativeCacheMaxBytes: 6, nativeMaxConcurrentImports: 2 }, {}))
    const { promise, resolve } = Promise.withResolvers<void>()
    let started = 0
    const load = async () => {
        if (++started === 2) resolve()
        await promise
        return bytes(4)()
    }
    const results = await Promise.allSettled([cache.acquire('first', load), cache.acquire('second', load)])
    const admitted = results.find((result) => result.status === 'fulfilled')
    const rejected = results.find((result) => result.status === 'rejected')
    expect(admitted?.value.size).toBe(4)
    expect(rejected?.reason).toMatchObject({ status: 503 })
    await admitted?.value.release()

    await expect(cache.acquire('large', bytes(7))).rejects.toMatchObject({ status: 413 })
    const replacement = await cache.acquire('replacement', bytes(6))
    expect(replacement.size).toBe(6)
    await replacement.release()
})

it('keeps an expired snapshot charged until its reader releases it', async () => {
    const cache = new NativeMediaCache(resolveMediaConfig({ nativeCacheMaxBytes: 6, nativeCacheTtlSeconds: 1 }, {}))
    const first = await cache.acquire('clip', bytes(6))
    await Bun.sleep(1100)
    await expect(cache.acquire('clip', bytes(1))).rejects.toMatchObject({ status: 503 })
    expect((await first.read(1, 2)).toString()).toBe('xx')

    await first.release()
    const second = await cache.acquire('clip', bytes(6))
    expect(second.size).toBe(6)
    await second.release()
})
