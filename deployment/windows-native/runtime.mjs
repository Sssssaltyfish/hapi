import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(root, 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
export const config = readConfig();
export const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
export const relayPath = `\\\\.\\pipe\\hapi-codex-app-tools-${config.ownerTag}`;
const proxyVariable = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
const defaultOverrides = [
    'features.code_mode_host=true',
    'features.prefer_mxc=true',
    'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'
];

export function script(name, args = []) {
    if (name === 'process-info.ps1') args = [...args, '-Utf8Output'];
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, name), ...args], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000
    });
    if (result.status !== 0) throw new Error(`Managed helper failed (${result.status ?? result.error?.code}): ${result.stderr?.trim() || result.error?.message || 'no diagnostic'}`);
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

export function prepareRuntime({ requireDesktop = false } = {}) {
    const settings = readConfig();
    const args = ['-Config', configPath, '-Utf8Output'];
    const explicitProxy = Object.hasOwn(settings, 'proxyEnvironment');
    if (!explicitProxy) args.push('-IncludeProxyEnvironment');
    if (requireDesktop) args.push('-RequireDesktop');
    const { proxyEnvironment: inheritedProxy, ...runtime } = script('resolve-runtime.ps1', args);
    const env = { ...process.env };
    const processProxy = {};
    for (const key of Object.keys(env)) {
        if (/^(CODEX_|HAPI_|CHATGPT_)/i.test(key) || /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key)) delete env[key];
        if (proxyVariable.test(key)) {
            processProxy[key.toUpperCase()] = env[key];
            delete env[key];
        }
    }
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    const proxy = explicitProxy ? settings.proxyEnvironment : { ...processProxy, ...inheritedProxy };
    for (const [key, value] of Object.entries(proxy ?? {})) {
        env[proxyVariable.test(key) ? key.toUpperCase() : key] = value;
    }
    Object.assign(env, {
        CODEX_HOME: config.codexHome,
        CODEX_CLI_PATH: runtime.cliExe,
        CODEX_MCP_NODE_PATH: settings.mcpNodeExe || runtime.nodeExe,
        CODEX_BROWSER_USE_NODE_PATH: settings.browserNodeExe || settings.mcpNodeExe || runtime.nodeExe,
        CODEX_APP_TOOLS_PIPE_PATH: relayPath
    });
    if (runtime.resourcesPath) env.CODEX_ELECTRON_RESOURCES_PATH = runtime.resourcesPath;
    env.NO_PROXY = [env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
    return { runtime, env, daemonConfigOverrides: Object.hasOwn(settings, 'daemonConfigOverrides') ? settings.daemonConfigOverrides : defaultOverrides };
}

export function daemonArguments(overrides) {
    if (!Array.isArray(overrides) || overrides.some(value => typeof value !== 'string' || value.indexOf('=') < 1)) {
        throw new Error('daemonConfigOverrides must be an array of key=value strings');
    }
    return ['app-server', '--listen', config.websocketUrl, '--analytics-default-enabled', ...overrides.flatMap(value => ['-c', value])];
}

export function desktopEnvironment(env) {
    return { ...env, CODEX_APP_SERVER_WS_URL: config.websocketUrl };
}
