import { randomUUID } from 'node:crypto'
import { MACHINE_DISPLAY_NAME_MAX_LENGTH } from '@hapi/protocol'
import { z } from 'zod'
import {
    getSettingsFile,
    readSettingsOrThrowCached,
    updateSettings,
    type Settings
} from '../config/settings'

export const nativeAddressSchema = z.string().min(1).max(4096).refine(value => {
    if (value.startsWith('unix://')) {
        return value.slice(7).startsWith('/') && !value.includes('\0')
    }
    try {
        const address = new URL(value)
        return (address.protocol === 'ws:' || address.protocol === 'wss:') && Boolean(address.hostname)
    } catch {
        return false
    }
}, 'Use an absolute unix:// socket or a ws:// or wss:// address')

export const nativeDisplayNameSchema = z.string().transform(value => value.trim()).pipe(
    z.string().max(MACHINE_DISPLAY_NAME_MAX_LENGTH)
)

const endpointSchema = z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    namespace: z.string(),
    endpoint: nativeAddressSchema,
    displayName: nativeDisplayNameSchema.optional(),
    token: z.string().optional(),
    defaultCwd: z.string().min(1).max(4096).optional()
}).strict()
const nameSchema = z.object({
    id: z.string(),
    namespace: z.string(),
    displayName: nativeDisplayNameSchema
}).strict()

export type StoredNativeEndpoint = z.infer<typeof endpointSchema>
export type NewNativeEndpoint = {
    address: string
    displayName?: string
    token?: string
    defaultCwd?: string
}

function parsed(settings: Settings) {
    const endpoints = z.array(endpointSchema).max(16).safeParse(settings.nativeCodexEndpoints ?? [])
    const names = z.array(nameSchema).safeParse(settings.nativeCodexDisplayNames ?? [])
    if (!endpoints.success || !names.success) {
        throw new Error('Invalid native machine configuration in settings.json')
    }
    if (new Set(endpoints.data.map(endpoint => endpoint.id)).size !== endpoints.data.length) {
        throw new Error('Duplicate native machine ID in settings.json')
    }
    return { endpoints: endpoints.data, names: names.data }
}

export class NativeMachineSettings {
    private readonly file: string

    constructor(dataDir: string) {
        this.file = getSettingsFile(dataDir)
    }

    async read() {
        return parsed(await readSettingsOrThrowCached(this.file))
    }

    async add(namespace: string, input: NewNativeEndpoint, reservedCount = 0): Promise<StoredNativeEndpoint> {
        const endpoint = endpointSchema.parse({
            id: randomUUID(),
            namespace,
            endpoint: input.address,
            ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
            ...(input.token ? { token: input.token } : {}),
            ...(input.defaultCwd ? { defaultCwd: input.defaultCwd } : {})
        })
        return updateSettings(this.file, settings => {
            const current = parsed(settings)
            if (current.endpoints.length + reservedCount >= 16) throw new Error('Native machine limit reached')
            if (current.endpoints.some(existing => existing.namespace === namespace && existing.endpoint === endpoint.endpoint)) {
                throw new Error('This native connection is already configured')
            }
            return {
                settings: { ...settings, nativeCodexEndpoints: [...current.endpoints, endpoint] },
                result: endpoint
            }
        })
    }

    async rename(namespace: string, id: string, displayName: string): Promise<void> {
        const name = nativeDisplayNameSchema.parse(displayName)
        return updateSettings(this.file, settings => {
            const current = parsed(settings)
            const names = current.names.filter(entry => entry.namespace !== namespace || entry.id !== id)
            if (name) names.push({ namespace, id, displayName: name })
            const endpoints = current.endpoints.map(endpoint => {
                if (endpoint.namespace !== namespace || endpoint.id !== id) return endpoint
                const { displayName: previous, ...connection } = endpoint
                return name ? { ...connection, displayName: name } : connection
            })
            return {
                settings: { ...settings, nativeCodexEndpoints: endpoints, nativeCodexDisplayNames: names },
                result: undefined
            }
        })
    }
}

/** A display address never includes credentials, query parameters, or fragments. */
export function nativeDisplayAddress(endpoint: string): string {
    if (endpoint.startsWith('unix://')) {
        return endpoint.split(/[?#]/, 1)[0]
    }
    try {
        const address = new URL(endpoint)
        address.username = ''
        address.password = ''
        address.search = ''
        address.hash = ''
        return address.href
    } catch {
        return 'Invalid native connection address'
    }
}

export function nativeMachineError(error: unknown, config: { endpoint?: string; token?: string }): string {
    const event = error && typeof error === 'object' ? error as { message?: unknown; error?: unknown } : undefined
    let message = error instanceof Error ? error.message
        : typeof event?.message === 'string' ? event.message
            : event?.error instanceof Error ? event.error.message
                : typeof error === 'string' ? error : ''
    if (!message.trim() || /^(?:Error:\s*)?\[object [^\]]+\]$/.test(message.trim())) {
        return 'Unable to connect to the native daemon. Check the connection address and authentication.'
    }
    if (config.endpoint) {
        message = message.replaceAll(config.endpoint, nativeDisplayAddress(config.endpoint))
        if (!config.endpoint.startsWith('unix://')) {
            try {
                const address = new URL(config.endpoint)
                for (const secret of [address.password, ...address.searchParams.values()]) {
                    if (secret) message = message.replaceAll(secret, '[redacted]')
                }
            } catch {
                // A malformed environment address must not leak through its URL error.
            }
        }
    }
    if (config.token) message = message.replaceAll(config.token, '[redacted]')
    message = message.replace(/\bwss?:\/\/[^\s"'<>]+/g, address => {
        try {
            return nativeDisplayAddress(address)
        } catch {
            return '[native address]'
        }
    })
    return message
}
