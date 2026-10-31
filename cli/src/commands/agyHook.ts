import type { CommandDefinition } from './types';

export const agyHookCommand: CommandDefinition = {
    name: 'agy-hook',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        const { runAgyHookForwarder } = await import('@/agy/headless/agyHookForwarder');
        await runAgyHookForwarder(commandArgs);
    },
};
