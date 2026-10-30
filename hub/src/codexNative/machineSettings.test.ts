import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { NativeRegistry, type NativeEndpointConfig } from './registry'
import { NativeService } from './service'
import { createNativeMachinesRoutes } from '../web/routes/nativeMachines'
import type { WebAppEnv } from '../web/middleware/auth'
import { nativeMachineError } from './machineSettings'

test('native machine settings survive restart, preserve services, and scope private connection configuration', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hapi-native-machines-'))
    const env = [{ id: 'default', label: 'Environment daemon', namespace: 'owner', endpoint: 'ws://user:secret@host/socket?token=hidden' }]
    let connections = 0
    let statusError: Error | undefined
    const factory = (config: NativeEndpointConfig) => {
        connections++
        return {
            config,
            authorized: (namespace: string) => namespace === config.namespace,
            readThread: async () => { throw new Error(`Cannot connect ${config.endpoint} ${config.token ?? ''}`) },
            catalog: async () => { throw new Error(`Cannot connect ${config.endpoint} ${config.token ?? ''}`) },
            withConnection: async (action: (client: unknown) => unknown) => {
                if (statusError) throw statusError
                return action({ initialization: {
                    platformOs: 'linux', platformFamily: 'unix', codexHome: '/native', userAgent: 'native-test'
                } })
            }
        } as unknown as NativeService
    }
    try {
        await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ unrelated: { keep: true } }))
        const registry = new NativeRegistry(env, factory, { dataDir })
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', c.req.header('X-Namespace') ?? 'owner'); await next() })
        app.route('/', createNativeMachinesRoutes(registry))
        const response = await app.request('/codex-native/endpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: 'unix:///new/daemon.sock', displayName: '  Desktop  ', token: 'private', defaultCwd: '/work' }) })
        expect(response.status).toBe(201)
        const added = (await response.json() as { endpoint: { id: string; label: string } }).endpoint
        expect(added.id).not.toBe('default')
        expect(added.label).toBe('Desktop')
        const service = registry.get('owner', 'default')!.service
        const rename = await app.request('/codex-native/endpoints/default', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: ' Alias ' }) })
        expect(rename.status).toBe(200)
        expect(registry.get('owner', 'default')!.service).toBe(service)
        expect(connections).toBe(2)
        const listing = await (await app.request('/codex-native/endpoints')).json() as { endpoints: unknown[] }
        expect(JSON.stringify(listing)).not.toContain('secret')
        expect(JSON.stringify(listing)).not.toContain('hidden')
        expect(JSON.stringify(listing)).not.toContain('private')
        const statusResponse = await app.request('/codex-native/endpoints/default/status')
        expect(await statusResponse.json()).toEqual({ enabled: true, available: true, platformOs: 'linux', platformFamily: 'unix', codexHome: '/native', userAgent: 'native-test' })
        statusError = new Error(`Cannot connect to ${env[0].endpoint}; password secret; token hidden`)
        const offline = JSON.stringify(await (await app.request('/codex-native/endpoints/default/status')).json())
        expect(offline).not.toContain('secret')
        expect(offline).not.toContain('hidden')
        expect(offline).not.toContain('user:')
        const unavailable = JSON.stringify({
            detail: await registry.resolve('owner', 'codex-native:default:test-thread'),
            listing: await registry.list('owner', [])
        })
        expect(unavailable).not.toContain('secret')
        expect(unavailable).not.toContain('hidden')
        expect(unavailable).not.toContain('private')
        const denied = await app.request('/codex-native/endpoints/default', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Namespace': 'other' }, body: JSON.stringify({ displayName: 'Wrong' }) })
        expect(denied.status).toBe(404)
        expect(await (await app.request('/codex-native/endpoints', { headers: { 'X-Namespace': 'other' } })).json()).toEqual({ endpoints: [] })
        const restarted = new NativeRegistry(env, factory, { dataDir })
        await restarted.refresh()
        expect(restarted.get('owner', 'default')!.config.label).toBe('Alias')
        expect(restarted.get('owner', added.id)!.config.endpoint).toBe('unix:///new/daemon.sock')
        await restarted.rename('owner', 'default', ' ')
        expect(restarted.get('owner', 'default')!.config.label).toBe('Environment daemon')
        const stored = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'))
        expect(stored.unrelated).toEqual({ keep: true })
        expect((await stat(join(dataDir, 'settings.json'))).mode & 0o777).toBe(0o600)
    } finally {
        await rm(dataDir, { recursive: true, force: true })
    }
})

test('invalid stored native machine config is explicit and never replaces environment connections', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hapi-native-machine-invalid-'))
    try {
        await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ nativeCodexEndpoints: [{ id: 'broken' }] }))
        const registry = new NativeRegistry([{ id: 'default', label: 'Env', namespace: 'owner', endpoint: 'unix:///daemon.sock' }], undefined, { dataDir })
        await expect(registry.refresh()).rejects.toThrow('Invalid native machine configuration')
        expect(registry.get('owner', 'default')!.config.endpoint).toBe('unix:///daemon.sock')
        expect(nativeMachineError(new Error('Invalid URL ws://user:secret@'), { endpoint: 'ws://user:secret@' })).not.toContain('secret')
        expect(nativeMachineError(new Error('[object ErrorEvent]'), {})).toContain('Unable to connect to the native daemon')
        expect(nativeMachineError({ message: 'connect ENOENT /missing.sock' }, {})).toBe('connect ENOENT /missing.sock')
        expect(nativeMachineError('', {})).toContain('Unable to connect to the native daemon')
    } finally {
        await rm(dataDir, { recursive: true, force: true })
    }
})

test('stalled earlier machines cannot starve a later healthy machine within the shared budget', async () => {
    const configs = Array.from({ length: 6 }, (_, index) => ({
        id: `machine-${index}`,
        label: `Machine ${index}`,
        namespace: 'owner',
        endpoint: `unix:///daemon-${index}.sock`
    }))
    let release!: () => void
    const offline = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    const deadlines = new Set<number>()
    let active = 0
    let maximum = 0
    const registry = new NativeRegistry(configs, config => ({
        config,
        authorized: (namespace: string) => namespace === config.namespace,
        catalog: async ({ deadline }: { deadline: number }) => {
            started.push(config.id)
            deadlines.add(deadline)
            active++
            maximum = Math.max(maximum, active)
            try {
                if (config.id !== 'machine-5') {
                    await offline
                    throw new Error('Daemon unavailable')
                }
                return { data: [{ id: 'healthy-thread', cwd: '/work', name: 'Healthy' }], nextCursor: null }
            } finally {
                active--
            }
        }
    } as unknown as NativeService))
    const pending = registry.list('owner', [])
    try {
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(started).toContain('machine-5')
        expect(started).toHaveLength(configs.length)
        expect(maximum).toBe(configs.length)
        expect(deadlines.size).toBe(1)
    } finally {
        release()
    }
    const result = await pending
    expect(result.sessions.map(session => session.id)).toEqual(['codex-native:machine-5:healthy-thread'])
    expect(result.nativePagination.filter(page => !page.available)).toHaveLength(5)
    expect(active).toBe(0)
})
