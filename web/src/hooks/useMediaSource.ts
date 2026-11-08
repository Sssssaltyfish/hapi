import { useEffect, useMemo, useReducer, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { parseCodexNativeSessionId, type NativeSessionIdentity } from '@/codex-native/session-key'

type MediaAddress = { url: string; expiresAt?: number }
type LoadMedia = (signal: AbortSignal) => Promise<Blob | MediaAddress>
type MediaResult = { address: MediaAddress; error?: undefined } | { address?: undefined; error: string }
type ImageSource = { path: string; mimeType: string } | { generatedImageId: string }

const IMAGE_ADDRESS_TTL_MS = 5 * 60_000
const MAX_IMAGE_ADDRESSES = 256
const recentImageAddresses = new Map<string, { address: MediaAddress; validUntil: number }>()

export function imageMediaCacheKey(api: ApiClient, sessionId: string, source: ImageSource, nativeMetadata?: NativeSessionIdentity | null) {
    const scope = api.getConversationCacheScope?.()
    if (!scope) return undefined
    const native = parseCodexNativeSessionId(sessionId) ?? nativeMetadata
    return JSON.stringify([scope.key, sessionId, native?.endpointId, native?.threadId, source])
}

function rememberImageAddress(key: string, address: MediaAddress) {
    const now = Date.now()
    if (address.expiresAt === undefined || address.expiresAt <= now) return
    recentImageAddresses.delete(key)
    recentImageAddresses.set(key, { address, validUntil: Math.min(address.expiresAt, now + IMAGE_ADDRESS_TTL_MS) })
    if (recentImageAddresses.size > MAX_IMAGE_ADDRESSES) {
        const oldest = recentImageAddresses.keys().next().value
        if (oldest !== undefined) recentImageAddresses.delete(oldest)
    }
}

export function useMediaSource(load: LoadMedia | null, imageCacheKey?: string) {
    const [revision, renew] = useReducer((value: number) => value + 1, 0)
    const [state, setState] = useState<{ load: LoadMedia; imageCacheKey?: string; revision: number; result: MediaResult }>()
    // The browser still owns the image bytes. Reuse the address immediately
    // while asking the Hub to check authorization and the current file version.
    const cached = useMemo(() => {
        const entry = imageCacheKey ? recentImageAddresses.get(imageCacheKey) : undefined
        return entry && entry.validUntil > Date.now() ? entry.address : undefined
    }, [imageCacheKey])

    useEffect(() => {
        if (!load) return
        const controller = new AbortController()
        let objectUrl: string | undefined
        const resolve = async () => {
            try {
                const source = await load(controller.signal)
                if (controller.signal.aborted) return
                const address = source instanceof Blob
                    ? { url: objectUrl = URL.createObjectURL(source) }
                    : source
                if (imageCacheKey && !objectUrl) rememberImageAddress(imageCacheKey, address)
                setState({ load, imageCacheKey, revision, result: { address } })
            } catch (error) {
                if (controller.signal.aborted) return
                if (imageCacheKey) recentImageAddresses.delete(imageCacheKey)
                setState({ load, imageCacheKey, revision, result: { error: error instanceof Error ? error.message : String(error) } })
            }
        }
        void resolve()
        return () => {
            controller.abort()
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [load, imageCacheKey, revision])

    // Keep the player mounted during ticket renewal so it can restore playback.
    const current = state?.load === load && state?.imageCacheKey === imageCacheKey ? state : undefined
    const result = current?.result
    const address = result ? result.address : load ? cached : undefined
    return {
        url: address?.url,
        error: result?.error,
        sourceRevision: current?.revision ?? (address ? 0 : undefined),
        onPlaybackError() {
            if (!address || (current?.revision ?? 0) !== revision) return false
            // A cached URL may fail before background validation reissues a
            // lost ticket under that same URL. Retry it once with a new revision.
            if (!(cached && revision === 0) && (address.expiresAt === undefined || Date.now() < address.expiresAt)) return false
            renew()
            return true
        },
    }
}
