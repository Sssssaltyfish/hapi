import { describe, expect, test } from 'bun:test'
import { createWorkspaceIdentityReader, desktopProjects, desktopThreadSelection } from './desktopSelection'

const state = {
    'local-projects': { p: { id: 'p', name: 'Project', rootPaths: ['C:\\Work\\Repo', 'C:\\Other'] } },
    'remote-projects': [{ id: 'r', label: 'Remote', remotePath: '/repo', hostId: 'remote' }],
    'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'p' } },
    'projectless-thread-ids': ['projectless'],
    'app-server-project-id-by-legacy-project-id-by-host': { 'local:C:\\Codex': { p: 'daemon-p' } },
}
const thread = (id: string, cwd = 'C:\\Elsewhere', extra = {}) => ({ id, cwd, source: 'vscode', ...extra })

describe('Windows desktop membership', () => {
    test('uses local project assignments, every root, and optional daemon IDs', () => {
        const selected = desktopThreadSelection(state, 'local', [
            thread('assigned'), thread('root', 'c:/work/repo'), thread('second', 'C:\\Other'),
            thread('daemon', undefined, { projectId: 'daemon-p' }),
            thread('projectless', 'C:\\Other', { projectId: 'daemon-p' }),
            thread('child', 'C:\\Other', { parentThreadId: 'parent' }),
            thread('exec', 'C:\\Other', { source: 'exec' }),
            thread('descendant', 'C:\\Other\\validation'),
        ])
        expect([...selected.keys()]).toEqual(['assigned', 'root', 'second', 'daemon'])
        expect(desktopProjects(state, 'remote')).toEqual([{ id: 'r', name: 'Remote', path: '/repo' }])
    })
    test('resolves worktree Git identity through the daemon without local filesystem access', async () => {
        const calls: string[][] = []
        const reader = createWorkspaceIdentityReader(async (_path, args) => {
            calls.push(args)
            return args[0] === 'rev-parse' ? 'C:/Work/tree\r\nC:/Work/repo/.git\r\n' : 'origin'
        })
        const identity = await reader('C:/Work/tree')
        expect(identity.git).toEqual({ root: 'c:/work/tree', commonDir: 'c:/work/repo/.git', originUrl: 'origin' })
        expect(await reader('C:/Work/tree')).toBe(identity)
        expect(calls).toHaveLength(2)
    })
})
