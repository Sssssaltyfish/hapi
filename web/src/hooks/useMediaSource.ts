import { useEffect, useMemo, useReducer, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { parseCodexNativeSessionId, type NativeSessionIdentity } from '@/codex-native/session-key'

type MediaAddress = { url: string; expiresAt?: number }
type LoadMedia = (signal: AbortSignal) => Promise<Blob | MediaAddress>
type MediaResult = { address: MediaAddress; error?: undefined } | { address?: undefined; error: string }
type MediaSource = { path: string; mimeType: string } | { generatedImageId: string }

const MAX_MEDIA_ADDRESSES = 256
const recentMediaAddresses = new Map<string, MediaAddress>()

export function mediaSourceCacheKey(api: ApiClient, sessionId: string, source: MediaSource, nativeMetadata?: NativeSessionIdentity | null) {
    const scope = api.getConversationCacheScope?.()
    if (!scope) return undefined
    const native = parseCodexNativeSessionId(sessionId) ?? nativeMetadata
    return JSON.stringify([scope.key, sessionId, native?.endpointId, native?.threadId, source])
}

function rememberMediaAddress(key: string, address: MediaAddress) {
    const now = Date.now()
    if (address.expiresAt === undefined || address.expiresAt <= now) return
    recentMediaAddresses.delete(key)
    recentMediaAddresses.set(key, address)
    if (recentMediaAddresses.size > MAX_MEDIA_ADDRESSES) {
        const oldest = recentMediaAddresses.keys().next().value
        if (oldest !== undefined) recentMediaAddresses.delete(oldest)
    }
}

export function useMediaSource(load: LoadMedia | null, cacheKey?: string) {
    const [revision, renew] = useReducer((value: number) => value + 1, 0)
    const [state, setState] = useState<{ load: LoadMedia; cacheKey?: string; revision: number; result: MediaResult }>()
    // The browser still owns the media bytes. Reuse an unexpired address immediately
    // while asking the Hub to check authorization and the current file version.
    const cached = useMemo(() => {
        const address = cacheKey ? recentMediaAddresses.get(cacheKey) : undefined
        return address?.expiresAt !== undefined && address.expiresAt > Date.now() ? address : undefined
    }, [cacheKey])

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
                if (cacheKey && !objectUrl) rememberMediaAddress(cacheKey, address)
                setState({ load, cacheKey, revision, result: { address } })
            } catch (error) {
                if (controller.signal.aborted) return
                if (cacheKey) recentMediaAddresses.delete(cacheKey)
                setState({ load, cacheKey, revision, result: { error: error instanceof Error ? error.message : String(error) } })
            }
        }
        void resolve()
        return () => {
            controller.abort()
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [load, cacheKey, revision])

    // Keep the player mounted during ticket renewal so it can restore playback.
    const current = state?.load === load && state?.cacheKey === cacheKey ? state : undefined
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
