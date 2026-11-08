const mediaOptions = {
    nativeCacheMaxBytes: ['HAPI_MEDIA_NATIVE_CACHE_MAX_BYTES', 256 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER],
    nativeCacheMaxEntries: ['HAPI_MEDIA_NATIVE_CACHE_MAX_ENTRIES', 16, 1, 1024],
    nativeCacheTtlSeconds: ['HAPI_MEDIA_NATIVE_CACHE_TTL_SECONDS', 7200, 1, 2_147_483],
    nativeMaxConcurrentImports: ['HAPI_MEDIA_NATIVE_MAX_CONCURRENT_IMPORTS', 1, 1, 64],
    nativeMaxPendingImports: ['HAPI_MEDIA_NATIVE_MAX_PENDING_IMPORTS', 8, 0, 4096],
    ticketTtlSeconds: ['HAPI_MEDIA_TICKET_TTL_SECONDS', 7200, 1, 30 * 24 * 60 * 60],
    maxTickets: ['HAPI_MEDIA_MAX_TICKETS', 4096, 1, 65_536],
    browserMaxAgeSeconds: ['HAPI_MEDIA_BROWSER_MAX_AGE_SECONDS', 300, 0, 30 * 24 * 60 * 60],
} as const

export type MediaConfig = Record<keyof typeof mediaOptions, number>

export function resolveMediaConfig(settings: Partial<MediaConfig>, env: NodeJS.ProcessEnv): MediaConfig {
    const result = {} as MediaConfig
    for (const key of Object.keys(mediaOptions) as Array<keyof MediaConfig>) {
        const [envName, fallback, min, max] = mediaOptions[key]
        const raw = env[envName]
        const configured = settings[key]
        const value = raw === undefined
            ? configured === undefined ? fallback : configured
            : /^\d+$/.test(raw.trim()) ? Number(raw) : NaN
        if (!Number.isSafeInteger(value) || value < min || value > max) {
            throw new Error(`${envName} (media.${key}) must be an integer from ${min} to ${max}`)
        }
        if (raw !== undefined && settings[key] === undefined) settings[key] = value
        result[key] = value
    }
    return result
}
