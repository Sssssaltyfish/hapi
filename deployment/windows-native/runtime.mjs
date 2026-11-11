import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(root, 'config.json');
export const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
export const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
export const relayPath = `\\\\.\\pipe\\hapi-codex-app-tools-${config.ownerTag}`;

export function script(name, args = []) {
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, name), ...args], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000
    });
    if (result.status !== 0) throw new Error(`Managed helper failed (${result.status ?? result.error?.code}): ${result.stderr?.trim() || result.error?.message || 'no diagnostic'}`);
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

export function prepareRuntime() {
    const runtime = script('resolve-runtime.ps1', ['-Config', configPath]);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(CODEX_|HAPI_|CHATGPT_)/i.test(key) || /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key)) delete env[key];
        if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)) delete env[key];
    }
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    Object.assign(env, config.proxyEnvironment, {
        CODEX_HOME: config.codexHome,
        CODEX_CLI_PATH: runtime.cliExe,
        CODEX_MCP_NODE_PATH: config.mcpNodeExe,
        CODEX_BROWSER_USE_NODE_PATH: config.browserNodeExe,
        CODEX_ELECTRON_RESOURCES_PATH: runtime.resourcesPath,
        CODEX_APP_TOOLS_PIPE_PATH: relayPath
    });
    env.NO_PROXY = [env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
    return { runtime, env };
}

export function desktopEnvironment(env) {
    return { ...env, CODEX_APP_SERVER_WS_URL: config.websocketUrl };
}
