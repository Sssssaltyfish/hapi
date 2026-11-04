import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importedWorktree } from './importWorktree';

it('groups a real linked worktree without changing cwd or grouping unrelated/nested directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-import-worktree-'));
    const repo = join(dir, 'repo'), linked = join(dir, 'linked'), other = join(dir, 'other');
    const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' });
    try {
        git('init', repo);
        git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial');
        git('-C', repo, 'worktree', 'add', '-b', 'feature', linked);
        git('init', other);
        mkdirSync(join(repo, 'validation-runs'));
        expect(importedWorktree(linked, repo)).toEqual({ basePath: repo, worktreePath: linked, name: 'linked', branch: 'feature' });
        expect(importedWorktree(other, repo)).toBeUndefined();
        expect(importedWorktree(join(repo, 'validation-runs'), repo)).toBeUndefined();
        expect(importedWorktree(repo, repo)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
