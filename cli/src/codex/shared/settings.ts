import { record } from './gateway';
export { settingsMatch } from '@hapi/protocol/nativeSettings.server';

/** Never silently convert a named/external sandbox into workspace-write. */
export function inheritedSandbox(settings: Record<string, unknown>): Record<string, unknown> {
    if (settings.activePermissionProfile) throw new Error('Create this conversation in the native TUI: named permission profile inheritance is not supported');
    const sandbox = record(settings.sandboxPolicy ?? settings.sandbox);
    if (!sandbox.type) return {};
    if (sandbox.type === 'dangerFullAccess') return { sandbox: 'danger-full-access' };
    if (sandbox.type === 'readOnly') {
        // Native readOnly can carry a restricted filesystem view, which the
        // public thread/start sandbox enum cannot express.
        if (sandbox.access && record(sandbox.access).type !== 'fullAccess') throw new Error('Cannot inherit a restricted read-only filesystem; create this conversation in the native TUI');
        return { sandbox: 'read-only' };
    }
    if (sandbox.type !== 'workspaceWrite') throw new Error(`Cannot inherit sandbox ${String(sandbox.type)}; create this conversation in the native TUI`);
    return { sandbox: 'workspace-write', config: {
        ...(Array.isArray(sandbox.writableRoots) ? { 'sandbox_workspace_write.writable_roots': sandbox.writableRoots } : {}),
        ...(typeof sandbox.networkAccess === 'boolean' ? { 'sandbox_workspace_write.network_access': sandbox.networkAccess } : {}),
        ...(typeof sandbox.excludeTmpdirEnvVar === 'boolean' ? { 'sandbox_workspace_write.exclude_tmpdir_env_var': sandbox.excludeTmpdirEnvVar } : {}),
        ...(typeof sandbox.excludeSlashTmp === 'boolean' ? { 'sandbox_workspace_write.exclude_slash_tmp': sandbox.excludeSlashTmp } : {})
    } };
}
