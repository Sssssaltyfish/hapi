import { posix, win32 } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { NativeRegistry } from '../../codexNative/registry'
import { assignDaemonProject, daemonProject, daemonProjectsPage, daemonProjectThreadsPage, daemonBackgroundThreadsPage, NativeBackgroundCursorError, renameDaemonProject } from '../../codexNative/projects'
import { record, text } from '../../codexNative/transport'
import { nativeCatalogEventResponse } from './nativeCatalogEvents'
import { reconcileNativeDirectory } from '../../codexNative/directoryCatchup'
import { nativeImportProjectsPage, nativeImportMembersPage, NativeImportCursorError } from '../../codexNative/importDirectory'
import type { NativeProjectPageOptions } from '../../codexNative/projects'

const absolutePath = z.string().min(1).max(4096).refine(path => !path.includes('\0') && (path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)))
const createProject = z.object({ name: z.string().trim().min(1).max(200), path: absolutePath, idempotencyKey: z.string().min(1).max(200) }).strict()
const pageOptions = z.object({ cursor: z.string().min(1).max(8192).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
const backgroundPageOptions = pageOptions.extend({ cursor: z.string().min(1).max(16384).optional() })
const importPageOptions = backgroundPageOptions.extend({ includeDesktop: z.literal('true').optional() })
const projectId = z.string().min(1).max(200).refine(value => !/[\x00-\x1f]/.test(value))
const assignment = z.object({ projectId: projectId.nullable() }).strict()
const rename = z.object({ name: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f]/.test(value)) }).strict()

export function createNativeCreationRoutes(registry: NativeRegistry): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/codex-native/endpoints/:endpointId/background/threads', async c => {
        const parsed = backgroundPageOptions.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid native background page' }, 400)
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        let page
        try { page = await daemonBackgroundThreadsPage(endpoint.service, parsed.data) }
        catch (error) {
            if (error instanceof NativeBackgroundCursorError) return c.json({ error: error.message }, 400)
            throw error
        }
        await registry.observeThreads(c.get('namespace'), endpoint.config.id, page.data)
        return c.json(page)
    })
    app.get('/codex-native/endpoints/:endpointId/projects', async c => {
        const parsed = importPageOptions.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid native workspace page' }, 400)
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        const read = async (options: NativeProjectPageOptions) => {
            const page = await daemonProjectsPage(endpoint.service, options)
            for (const project of page.data) await registry.observeProject(c.get('namespace'), endpoint.config.id, project)
            return page
        }
        try { return c.json(parsed.data.includeDesktop
            ? await nativeImportProjectsPage(await registry.cachedDirectorySessions(c.get('namespace'), endpoint.config.id), parsed.data, read)
            : await read(parsed.data)) }
        catch (error) { if (error instanceof NativeImportCursorError) return c.json({ error: error.message }, 400); throw error }
    })
    app.get('/codex-native/endpoints/:endpointId/desktop-projects/:projectId/threads', async c => {
        const parsed = importPageOptions.safeParse(c.req.query()), id = c.req.param('projectId')
        if (!parsed.success || !projectId.safeParse(id).success) return c.json({ error: 'Invalid native workspace members page' }, 400)
        const sessions = await registry.cachedDirectorySessions(c.get('namespace'), c.req.param('endpointId'))
        try { return c.json(await nativeImportMembersPage(sessions, null, id, parsed.data)) }
        catch (error) { if (error instanceof NativeImportCursorError) return c.json({ error: error.message }, 400); throw error }
    })
    for (const path of ['/codex-native/endpoints/:endpointId/projects/:projectId/threads', '/codex-native/endpoints/:endpointId/projectless/threads']) {
        app.get(path, async c => {
            const parsed = importPageOptions.safeParse(c.req.query())
            const id = c.req.param('projectId')
            if (!parsed.success || (id !== undefined && !projectId.safeParse(id).success))
                return c.json({ error: 'Invalid native workspace members page' }, 400)
            const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
            const read = async (options: NativeProjectPageOptions) => {
                const page = await daemonProjectThreadsPage(endpoint.service, id ?? null, options)
                await registry.observeThreads(c.get('namespace'), endpoint.config.id, page.data)
                return page
            }
            try { return c.json(parsed.data.includeDesktop
                ? await nativeImportMembersPage(await registry.cachedDirectorySessions(c.get('namespace'), endpoint.config.id), id ?? null, undefined, parsed.data, read)
                : await read(parsed.data)) }
            catch (error) { if (error instanceof NativeImportCursorError) return c.json({ error: error.message }, 400); throw error }
        })
    }
    app.post('/codex-native/endpoints/:endpointId/threads/:threadId/project', async c => {
        const parsed = assignment.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success || !projectId.safeParse(c.req.param('threadId')).success)
            return c.json({ error: 'Invalid native workspace assignment' }, 400)
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        let thread
        try {
            thread = await assignDaemonProject(endpoint.service, c.req.param('threadId'), parsed.data.projectId)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Native workspace assignment failed', outcome: 'unconfirmed' }, 502)
        }
        let displayTrackingError: string | undefined
        try { await registry.observeThread(c.get('namespace'), endpoint.config.id, { ...thread,
            ...(parsed.data.projectId === null ? { desktopProjectCleared: true } : {}) }) }
        catch { displayTrackingError = 'The workspace changed, but its HAPI display cache could not be refreshed' }
        return c.json({ thread, ...(displayTrackingError ? { displayTrackingError } : {}) })
    })
    app.patch('/codex-native/endpoints/:endpointId/projects/:projectId', async c => {
        const parsed = rename.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success || !projectId.safeParse(c.req.param('projectId')).success)
            return c.json({ error: 'Invalid native workspace name' }, 400)
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        let project
        try {
            project = await renameDaemonProject(endpoint.service, c.req.param('projectId'), parsed.data.name)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Native workspace rename failed', outcome: 'unconfirmed' }, 502)
        }
        let displayTrackingError: string | undefined
        try { await registry.observeProject(c.get('namespace'), endpoint.config.id, project) }
        catch { displayTrackingError = 'The workspace name changed, but its HAPI display cache could not be refreshed' }
        return c.json({ project, ...(displayTrackingError ? { displayTrackingError } : {}) })
    })
    app.get('/codex-native/endpoints/:endpointId/catalog/events', c => {
        const endpoint = registry.get(c.get('namespace'), c.req.param('endpointId'))!
        return nativeCatalogEventResponse(
            c, endpoint.service,
            event => registry.observeCatalogEvent(c.get('namespace'), endpoint.config.id, { method: event.method, params: record(event.params) }),
            listener => registry.subscribeVisibility(c.get('namespace'), endpoint.config.id, () => listener({ method: 'hapi/visibility/updated', params: { endpointId: endpoint.config.id } })),
            signal => reconcileNativeDirectory(registry, c.get('namespace'), endpoint.config.id, signal),
        )
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
