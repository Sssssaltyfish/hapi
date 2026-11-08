export interface EmbeddedAsset {
    relativePath: string;
    sourcePath: string;
}

export const embeddedSkillAssets: EmbeddedAsset[] = [];

export async function loadEmbeddedAssets(): Promise<EmbeddedAsset[]> {
    throw new Error('Embedded assets are only available in Bun-compiled binaries.');
}
