import { posix, win32 } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { NativeRegistry } from '../../codexNative/registry'
import { daemonProject } from '../../codexNative/projects'
import { record, text } from '../../codexNative/transport'

const absolutePath = z.string().min(1).max(4096).refine(path => !path.includes('\0') && (path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)))
const createProject = z.object({ name: z.string().trim().min(1).max(200), path: absolutePath, idempotencyKey: z.string().min(1).max(200) }).strict()

export function createNativeCreationRoutes(registry: NativeRegistry): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/codex-native/endpoints/:endpointId/projects', async c => {
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        const page = record(await endpoint.service.call('project/list', { limit: 100, ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}) }))
        return c.json({ data: (Array.isArray(page.data) ? page.data : []).flatMap(value => { const project = daemonProject(value); return project ? [project] : [] }), nextCursor: text(page.nextCursor) ?? null })
    })
    app.post('/codex-native/endpoints/:endpointId/projects', async c => {
        const parsed = createProject.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid native workspace options' }, 400)
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        const { name, path, idempotencyKey } = parsed.data
        const metadata = record(await endpoint.service.call('fs/getMetadata', { path }))
        if (metadata.isDirectory !== true) return c.json({ error: 'Workspace root must be an existing directory' }, 400)
        const response = record(await endpoint.service.call('project/create', { name, roots: [{ path }], idempotencyKey }))
        const project = daemonProject(response.project)
        if (!project) throw new Error('Native workspace creation returned no project')
        return c.json({ project }, 201)
    })
    app.get('/codex-native/endpoints/:endpointId/directory', async c => {
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        let path = c.req.query('path')
        if (!path) {
            const initialization = await endpoint.service.withConnection(async client => client.initialization)
            const home = text(initialization.codexHome)
            if (!home) return c.json({ error: 'Enter an absolute directory to browse this machine' }, 400)
            const paths = /^[A-Za-z]:[\\/]/.test(home) || home.startsWith('\\\\') ? win32 : posix
            path = paths.dirname(home)
        }
        if (!absolutePath.safeParse(path).success) return c.json({ error: 'Native directory path must be absolute' }, 400)
        const paths = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') ? win32 : posix
        const response = record(await endpoint.service.call('fs/readDirectory', { path }))
        const includeHidden = c.req.query('includeHidden') === 'true'
        const directories = (Array.isArray(response.entries) ? response.entries : []).flatMap(value => {
            const entry = record(value), fileName = text(entry.fileName)
            if (!fileName || entry.isDirectory !== true || fileName === '.' || fileName === '..' || /[\\/\0]/.test(fileName) || (!includeHidden && fileName.startsWith('.'))) return []
            return [{ fileName, path: paths.join(path!, fileName) }]
        }).sort((a, b) => a.fileName.localeCompare(b.fileName))
        return c.json({ path, parentPath: paths.dirname(path), entries: directories.slice(0, 2000), truncated: directories.length > 2000 })
    })
    return app
}
