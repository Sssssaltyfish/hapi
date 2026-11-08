import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const stateDirectory = path.join(root, 'state');
fs.mkdirSync(stateDirectory, { recursive: true });
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const children = new Set();
const sockets = new Set();
let daemon;
let desktop;
let desktopIdentity;
let daemonIdentity;
let target;
let resolving;
let stopping = false;
let restarting = false;
let restartCount = 0;
let watchBusy = false;
let daemonReady = false;
let lastTargetCheck = 0;

function log(event) {
    fs.appendFileSync(path.join(stateDirectory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

function script(name, args = []) {
    return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, name), ...args], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000
    });
}

function parseOutput(result) {
    if (result.status !== 0) throw new Error('Managed helper failed');
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

const runtime = parseOutput(script('resolve-runtime.ps1', ['-Config', path.join(root, 'config.json')]));
const relayPath = `\\\\.\\pipe\\hapi-codex-app-tools-${config.ownerTag}`;
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

function identify(processId) {
    return parseOutput(script('process-info.ps1', ['-ProcessId', String(processId)]));
}
const supervisorIdentity = identify(process.pid);

function launch(executable, args, childEnvironment) {
    let stderr = 'ignore';
    if (executable === runtime.cliExe) {
        const file = path.join(stateDirectory, 'daemon-stderr.log');
        if (fs.existsSync(file) && fs.statSync(file).size > 4 * 1024 * 1024) fs.renameSync(file, file + '.previous');
        stderr = fs.openSync(file, 'a');
    }
    const child = spawn(executable, args, {
        env: childEnvironment,
        cwd: config.codexHome,
        windowsHide: true,
        stdio: ['ignore', 'ignore', stderr]
    });
    if (typeof stderr === 'number') fs.closeSync(stderr);
    children.add(child);
    child.once('exit', () => children.delete(child));
    child.once('error', error => log({ event: 'child-error', kind: executable === runtime.cliExe ? 'daemon' : 'desktop', code: error.code }));
    return child;
}

function save() {
    const value = {
        supervisor: supervisorIdentity,
        daemon: daemonIdentity,
        desktop: desktopIdentity,
        url: config.websocketUrl,
        toolsRelay: relayPath,
        toolsPipeReady: !!target,
        daemonReady,
        desktopBackendConnected: target?.backendConnected === true,
        at: new Date().toISOString()
    };
    const temporary = path.join(stateDirectory, 'managed.json.tmp');
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, path.join(stateDirectory, 'managed.json'));
}

async function findTarget() {
    if (!resolving) {
        resolving = new Promise(resolve => {
            const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'find-tools-pipe.ps1'), '-ExpectedDesktopExe', runtime.desktopExe, '-OwnerSid', config.ownerSid, '-BackendPort', new URL(config.websocketUrl).port], {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'ignore']
            });
            children.add(child);
            let output = '';
            const timer = setTimeout(() => child.kill(), 5000);
            child.stdout.on('data', chunk => { output += chunk; });
            child.on('error', () => {});
            child.once('close', () => {
                children.delete(child);
                clearTimeout(timer);
                try {
                    resolve(JSON.parse(output.replace(/^\uFEFF/, '')));
                } catch {
                    resolve(null);
                }
            });
        }).finally(() => { resolving = null; });
    }
    return resolving;
}

async function requireFreePort() {
    const url = new URL(config.websocketUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw new Error('Only loopback backend is supported');
    await new Promise((resolve, reject) => {
        const check = net.createServer();
        check.once('error', reject);
        check.listen(Number(url.port), url.hostname, () => check.close(resolve));
    });
}

async function initializeOwnedDaemon() {
    const url = new URL(config.websocketUrl);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (stopping || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Owned daemon exited');
        const result = await new Promise(resolve => {
            const ws = new WebSocket(config.websocketUrl);
            const timer = setTimeout(() => { ws.close(); resolve(null); }, 1500);
            ws.onerror = () => { clearTimeout(timer); resolve(null); };
            ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hapi_windows_managed', version: '1' }, capabilities: { experimentalApi: true } } }));
            ws.onmessage = event => {
                const message = JSON.parse(event.data);
                if (message.id !== 1) return;
                clearTimeout(timer);
                if (message.result) ws.send(JSON.stringify({ method: 'initialized' }));
                ws.close();
                resolve(message.result ?? { rejected: true });
            };
        });
        if (result) {
            const owner = parseOutput(script('process-info.ps1', ['-ProcessId', String(daemon.pid), '-ListeningPort', url.port]));
            if (!owner.listening || result.platformFamily !== 'windows' || path.resolve(result.codexHome ?? '').toLowerCase() !== path.resolve(config.codexHome).toLowerCase()) throw new Error('Backend identity mismatch');
            daemonIdentity = owner;
            log({ event: 'daemon-initialize-verified', pid: daemon.pid, platformFamily: result.platformFamily });
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Owned daemon initialization timed out');
}

async function startDaemon() {
    daemonReady = false;
    await requireFreePort();
    daemon = launch(runtime.cliExe, [
        'app-server', '--listen', config.websocketUrl,
        '--analytics-default-enabled',
        '-c', 'features.code_mode_host=true',
        '-c', 'features.prefer_mxc=true',
        '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'
    ], env);
    log({ event: 'daemon-start', pid: daemon.pid });
    await initializeOwnedDaemon();
    daemonReady = true;
    daemon.once('exit', async code => {
        log({ event: 'daemon-exit', code });
        if (stopping || restarting) return;
        if (++restartCount > 3) return shutdown('daemon-restart-limit');
        restarting = true;
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
            await startDaemon();
        } catch {
            await shutdown('daemon-restart-failed');
        } finally {
            restarting = false;
        }
    });
    save();
}

function startDesktop() {
    if (desktop && desktop.exitCode === null && desktop.signalCode === null) return;
    target = null;
    desktop = launch(runtime.desktopExe, [], { ...env, CODEX_APP_SERVER_WS_URL: config.websocketUrl });
    desktopIdentity = identify(desktop.pid);
    desktop.once('exit', () => {
        target = null;
        desktopIdentity = null;
        save();
    });
    log({ event: 'desktop-start', pid: desktop.pid });
    save();
}

async function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    log({ event: 'supervisor-stop', reason });
    for (const socket of sockets) socket.destroy();
    relay.close();
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    }
    fs.writeFileSync(path.join(stateDirectory, 'stopped.json'), JSON.stringify({ at: new Date().toISOString(), reason }));
    process.exit(0);
}

const relay = net.createServer(async client => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => {});
    client.pause();
    const found = await findTarget();
    if (!found || client.destroyed) return client.destroy();
    target = found;
    const upstream = net.connect(found.pipe);
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
    });
});

const watch = setInterval(async () => {
    if (watchBusy || stopping) return;
    watchBusy = true;
    try {
        if (fs.existsSync(path.join(stateDirectory, 'stop'))) return await shutdown('requested');
        if (fs.existsSync(path.join(stateDirectory, 'open'))) {
            fs.rmSync(path.join(stateDirectory, 'open'));
            startDesktop();
        }
        if (target && Date.now() - lastTargetCheck < 30000) return;
        lastTargetCheck = Date.now();
        const found = await findTarget();
        if (found) {
            if (!target || target.processId !== found.processId) log({ event: 'tools-pipe-bound', processId: found.processId });
            target = found;
            desktopIdentity = identify(found.desktopProcessId);
        } else {
            target = null;
            desktopIdentity = null;
        }
        save();
    } catch {
        log({ event: 'watch-failed' });
    } finally {
        watchBusy = false;
    }
}, 3000);

process.on('SIGTERM', () => shutdown('signal'));
relay.once('error', () => shutdown('relay-unavailable'));
relay.listen(relayPath, async () => {
    try {
        save();
        await startDaemon();
        startDesktop();
    } catch {
        await shutdown('startup-failed');
    }
});
