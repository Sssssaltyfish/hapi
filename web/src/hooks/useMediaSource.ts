import { useEffect, useReducer, useState } from 'react'

type MediaAddress = { url: string; expiresAt?: number }
type LoadMedia = (signal: AbortSignal) => Promise<Blob | MediaAddress>
type MediaResult = { address: MediaAddress; error?: undefined } | { address?: undefined; error: string }

export function useMediaSource(load: LoadMedia | null) {
    const [revision, renew] = useReducer((value: number) => value + 1, 0)
    const [state, setState] = useState<{ load: LoadMedia; revision: number; result: MediaResult }>()

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
                setState({ load, revision, result: { address } })
            } catch (error) {
                if (controller.signal.aborted) return
                setState({ load, revision, result: { error: error instanceof Error ? error.message : String(error) } })
            }
        }
        void resolve()
        return () => {
            controller.abort()
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [load, revision])

    // Keep the player mounted during ticket renewal so it can restore playback.
    const result = state?.load === load ? state?.result : undefined
    return {
        url: result?.address?.url,
        error: result?.error,
        onPlaybackError() {
            const expiresAt = result?.address?.expiresAt
            if (state?.revision !== revision || expiresAt === undefined || Date.now() < expiresAt) return false
            renew()
            return true
        },
    }
}
