import { record, string } from './gateway';

export type DesktopProject = { id: string; name: string; path: string };

/** Explicit desktop membership, never a recursive filesystem/path match. */
export function desktopThreadSelection(value: unknown, hostId: string, supplemental: unknown = {}): Map<string, DesktopProject> {
    const state = record(value);
    if (!Array.isArray(state['remote-projects']) || typeof state['thread-project-assignments'] !== 'object'
        || state['thread-project-assignments'] === null || Array.isArray(state['thread-project-assignments'])) {
        throw new Error('Unsupported desktop project state; discovery is suspended');
    }
    const projects = new Map<string, DesktopProject>();
    for (const item of state['remote-projects']) {
        const p = record(item);
        if (p.hostId !== hostId) continue;
        const id = string(p.id), path = string(p.remotePath), name = string(p.label);
        if (!id || !path || !name) throw new Error('Invalid desktop project');
        projects.set(id, { id, path, name });
    }
    const result = new Map<string, DesktopProject>();
    const atoms = record(state['electron-persisted-atom-state']);
    for (const [id, value] of Object.entries(record(state['thread-project-assignments']))) {
        const assignment = record(value);
        const project = projects.get(string(assignment.projectId) ?? '');
        if (project && assignment.projectKind === 'remote' && assignment.hostId === hostId
            && atoms[`codex-writing-block-deleted-thread-v1:${id}`] !== true) result.set(id, project);
    }
    if (!supplemental || typeof supplemental !== 'object' || Array.isArray(supplemental)) throw new Error('Invalid supplemental membership');
    for (const [id, projectId] of Object.entries(supplemental)) {
        if (typeof projectId !== 'string' || !projects.has(projectId)) throw new Error('Unknown supplemental desktop project');
        if (atoms[`codex-writing-block-deleted-thread-v1:${id}`] !== true) result.set(id, projects.get(projectId)!);
    }
    return result;
}
