import { posix, win32 } from 'node:path'
import type { NativeService } from './service'
import { record, text, type NativeRecord } from './transport'
import { codexAnnotatedRequest, splitCodexInputContext } from '@hapi/protocol/codexInputContext'

export type NativeSuggestion = {
    key: string; text: string; label: string; description?: string
    group?: 'files' | 'folders' | 'skills' | 'apps' | 'plugins'
}
type Skill = { name: string; path: string; enabled: boolean }
type Catalog = {
    expires: number
    skills?: Skill[]
    targets: NativeSuggestion[]
    loading?: Promise<void>
}
const catalogs = new WeakMap<NativeService, Map<string, Catalog>>()
const referenceCapabilities = new WeakMap<NativeService, Map<string, { expires: number; loading: Promise<boolean> }>>()
const quotedMention = (path: string) => `@"${path.replace(/(["\\])/g, '\\$1')}"`

/** Tool presence is checked on this thread's actual MCP connection, never inferred from another chat. */
export function threadReferenceCapability(service: NativeService, threadId: string): Promise<boolean> {
    let cache = referenceCapabilities.get(service)
    if (!cache) { cache = new Map(); referenceCapabilities.set(service, cache) }
    const previous = cache.get(threadId)
    if (previous && previous.expires > Date.now()) return previous.loading
    if (cache.size >= 64) cache.delete(cache.keys().next().value!)
    const loading = discover(service, 'mcpServerStatus/list', {
        threadId, serverName: 'codex_app', detail: 'toolsAndAuthOnly', limit: 100,
    }, 3000).then(response => (Array.isArray(record(response).data) ? record(response).data as unknown[] : []).some(value => {
        const server = record(value)
        return server.name === 'codex_app' && server.runtimeStatus === 'connected' && !server.toolsError
            && record(record(server.tools).read_thread).name === 'read_thread'
    })).catch(() => false)
    cache.set(threadId, { expires: Date.now() + 15_000, loading })
    return loading
}

/** Keep local file references in text and resolve app/plugin mentions separately. */
export function nativeMessageInput(message: string, skills: readonly Skill[] = []): NativeRecord[] {
    const annotated = codexAnnotatedRequest(message)
    if (annotated) {
        // Desktop reads the annotation and its request from one text input.
        const prefix = annotated.text.slice(0, annotated.text.length - annotated.body.length)
        return nativeMessageParts(annotated.body, skills, prefix)
    }
    const body = splitCodexInputContext(message).body
    if (body !== message && message.endsWith(body)) {
        const prefix = message.slice(0, message.length - body.length)
        return [{ type: 'text', text: prefix, text_elements: [] }, ...(body ? nativeMessageParts(body, skills) : [])]
    }
    return nativeMessageParts(message, skills)
}

function nativeMessageParts(message: string, skills: readonly Skill[], annotationPrefix?: string): NativeRecord[] {
    const input: NativeRecord[] = []
    const selectedSkills = new Map<string, NativeRecord>()
    const mentions = /(^|\s)(?:@"((?:\\.|[^"\\])*)"|\$([^\s]+)(?=\s|$))/g
    let pendingText = annotationPrefix ?? ''
    let end = 0
    for (const match of message.matchAll(mentions)) {
        const start = match.index + match[1].length
        const skill = match[3] ? skills.find(skill => skill.enabled && skill.name === match[3]) : undefined
        if (skill) {
            // Desktop renders the link from history text. The daemon resolves
            // the typed selection and deduplicates it against the same linked path.
            const label = `$${skill.name}`
                .replaceAll('\\', '\\\\')
                .replaceAll('[', '\\[')
                .replaceAll('](', ']\\(')
                .replaceAll(']', '\\]')
            const destination = skill.path.replace(/[\\)]/g, '\\$&')
            pendingText += message.slice(end, start) + `[${label}](${destination})`
            selectedSkills.set(skill.path, { type: 'skill', name: skill.name, path: skill.path })
            end = match.index + match[0].length
            continue
        }
        const path = match[2]?.replace(/\\(["\\])/g, '$1')
        // Current daemon mention resolution handles app/plugin URIs. Local paths
        // must remain in the text or the model never receives the file reference.
        if (!path || !/^(app|plugin):\/\//.test(path)) continue
        if (annotationPrefix === undefined) {
            pendingText += message.slice(end, start)
            if (pendingText) input.push({ type: 'text', text: pendingText, text_elements: [] })
            pendingText = ''
            end = match.index + match[0].length
        }
        input.push({
            type: 'mention',
            name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
            path,
        })
    }
    pendingText += message.slice(end)
    const textInput = { type: 'text', text: pendingText, text_elements: [] }
    if (annotationPrefix !== undefined) return [textInput, ...input, ...selectedSkills.values()]
    if (pendingText || !input.length) input.push(textInput)
    return [...input, ...selectedSkills.values()]
}

async function skillsFor(service: NativeService, cwd: string): Promise<Skill[]> {
    const response = record(await service.call('skills/list', { cwds: [cwd], forceReload: false }, Date.now() + 5000))
    return (Array.isArray(response.data) ? response.data : []).flatMap((value) => {
        const group = record(value)
        return (Array.isArray(group.skills) ? group.skills : []).flatMap((value) => {
            const skill = record(value)
            return typeof skill.name === 'string' && typeof skill.path === 'string'
                ? [{ name: skill.name, path: skill.path, enabled: skill.enabled === true }]
                : []
        })
    })
}

async function discover(
    service: NativeService,
    method: string,
    params: NativeRecord,
    deadline: number
) {
    return service.withConnection((client) => client.request(method, params), Date.now() + deadline)
}

function catalogFor(service: NativeService, threadId: string, cwd: string): Catalog {
    let cache = catalogs.get(service)
    if (!cache) {
        cache = new Map()
        catalogs.set(service, cache)
    }
    const previous = cache.get(threadId)
    if (previous && previous.expires > Date.now()) return previous
    if (cache.size >= 64) cache.delete(cache.keys().next().value!)
    const catalog: Catalog = { expires: Date.now() + 60_000, targets: [] }
    cache.set(threadId, catalog)
    // First-query discovery is bounded and shared by concurrent keystrokes. Apps
    // have their own shorter deadline and cannot cancel a slower plugin lookup.
    catalog.loading = Promise.allSettled([
        skillsFor(service, cwd).then(skills => { catalog.skills = skills }),
        discover(
            service,
            'plugin/list',
            {
                cwds: [cwd],
                forceRefetch: false,
                marketplaceKinds: ['local'],
            },
            5000
        ).then((value) => {
            for (const marketplace of Array.isArray(record(value).marketplaces)
                ? (record(value).marketplaces as unknown[])
                : []) {
                for (const value of Array.isArray(record(marketplace).plugins)
                    ? (record(marketplace).plugins as unknown[])
                    : []) {
                    const plugin = record(value)
                    if (
                        plugin.installed !== true ||
                        plugin.enabled !== true ||
                        !text(plugin.id) ||
                        !text(plugin.name)
                    )
                        continue
                    const path = `plugin://${plugin.id}`
                    catalog.targets.push({
                        key: path,
                        text: quotedMention(path),
                        label: `@${plugin.name}`,
                        description: 'Plugin',
                        group: 'plugins',
                    })
                }
            }
        }),
        discover(service, 'app/list', { threadId, limit: 100, forceRefetch: false }, 2000).then(
            (response) => {
                for (const value of Array.isArray(record(response).data)
                    ? (record(response).data as unknown[])
                    : []) {
                    const app = record(value)
                    if (
                        app.isAccessible !== true ||
                        app.isEnabled === false ||
                        !text(app.id) ||
                        !text(app.name)
                    )
                        continue
                    const path = `app://${app.id}`
                    catalog.targets.push({
                        key: path,
                        text: quotedMention(path),
                        label: `@${app.name}`,
                        description: 'App',
                        group: 'apps',
                    })
                }
            }
        ),
    ]).then(() => {})
    return catalog
}

export async function messageInput(
    service: NativeService,
    threadId: string,
    message: string
): Promise<NativeRecord[]> {
    if (!/(^|\s)\$[^\s]+(?=\s|$)/.test(splitCodexInputContext(message).body)) return nativeMessageInput(message)
    const cwd = text(record(record(await service.readThread(threadId)).thread).cwd)
    if (!cwd) return nativeMessageInput(message)
    return nativeMessageInput(message, await skillsFor(service, cwd))
}

export async function mentionSuggestions(
    service: NativeService,
    threadId: string,
    query: string
): Promise<NativeSuggestion[]> {
    if (!query.startsWith('@') && !query.startsWith('$')) return []
    const cwd = text(record(record(await service.readThread(threadId)).thread).cwd)
    if (!cwd) return []
    const catalog = catalogFor(service, threadId, cwd)
    const search = query.slice(1).toLowerCase()
    if (query.startsWith('$')) {
        catalog.skills ??= await skillsFor(service, cwd)
        return catalog.skills
            .filter((skill) => skill.enabled && skill.name.toLowerCase().includes(search))
            .map((skill) => ({
                key: skill.path,
                text: `$${skill.name}`,
                label: `$${skill.name}`,
                description: skill.path,
                group: 'skills' as const,
            }))
    }
    await catalog.loading
    const paths = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? win32 : posix
    const response = record(
        query.length === 1
            ? await service.call('fs/readDirectory', { path: cwd })
            : await service.call('fuzzyFileSearch', { roots: [cwd], query: query.slice(1) })
    )
    const matches =
        query.length === 1
            ? (Array.isArray(response.entries) ? response.entries : []).map((value) => {
                  const entry = record(value)
                  return {
                      path: entry.fileName,
                      file_name: entry.fileName,
                      match_type: entry.isDirectory
                          ? 'directory'
                          : entry.isFile
                            ? 'file'
                            : undefined,
                  }
              })
            : Array.isArray(response.files)
              ? response.files
              : []
    const files = matches.flatMap((value) => {
        const file = record(value)
        if (
            typeof file.path !== 'string' ||
            !['file', 'directory'].includes(String(file.match_type))
        )
            return []
        const path = paths.resolve(cwd, file.path)
        const relative = paths.relative(cwd, path)
        if (
            relative === '..' ||
            relative.startsWith(`..${paths.sep}`) ||
            paths.isAbsolute(relative)
        )
            return []
        return [
            {
                key: path,
                text: quotedMention(path),
                label: `@${file.file_name ?? paths.basename(path)}`,
                description: path,
                group: file.match_type === 'directory' ? 'folders' as const : 'files' as const,
            },
        ]
    })
    return [
        ...files,
        ...(catalog.skills ?? []).filter(skill => skill.enabled && skill.name.toLowerCase().includes(search)).map(skill => ({
            key: `skill:${skill.path}`, text: `$${skill.name}`, label: `$${skill.name}`, description: skill.path, group: 'skills' as const,
        })),
        ...catalog.targets.filter((target) => target.label.toLowerCase().includes(search)),
    ]
}
