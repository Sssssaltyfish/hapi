import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configuration } from '@/configuration';
import { isBunCompiled, projectPath } from '@/projectPath';

let installation: Promise<void> | undefined;

async function installBundledSkills(root: string): Promise<void> {
    const { embeddedSkillAssets } = await import('#embedded-assets');

    for (const asset of embeddedSkillAssets) {
        const path = join(root, asset.relativePath);
        const bytes = Buffer.from(await Bun.file(asset.sourcePath).arrayBuffer());
        const installed = await readFile(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        });
        if (installed?.equals(bytes)) continue;

        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, bytes, { flag: 'wx' });
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

export async function ensureBundledSkills(): Promise<string> {
    if (!isBunCompiled()) {
        return join(projectPath(), '..', 'skills');
    }

    // Native providers can link to this directory across CLI version upgrades.
    const root = join(configuration.happyHomeDir, 'bundled-skills');
    installation ??= installBundledSkills(root).catch((error: unknown) => {
        installation = undefined;
        throw error;
    });
    await installation;
    return root;
}
