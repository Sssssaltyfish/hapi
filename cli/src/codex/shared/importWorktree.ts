import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { WorktreeMetadata } from '@hapi/protocol';

/** Preserve execution cwd, grouping only verified linked worktrees under their project. */
export function importedWorktree(cwd: string, projectRoot?: string): WorktreeMetadata | undefined {
    if (!projectRoot || resolve(cwd) === resolve(projectRoot)) return;
    const git = (path: string, args: string[]) => execFileSync('git', ['-C', path, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    try {
        const common = (path: string) => realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir'])));
        if (common(cwd) !== common(projectRoot)) return;
        const top = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
        if (top !== realpathSync(cwd)) return;
        return { basePath: projectRoot, worktreePath: cwd, name: basename(cwd),
            branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) };
    } catch { return; }
}
