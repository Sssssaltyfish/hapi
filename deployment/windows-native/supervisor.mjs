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
let status = 'starting';
let failure;
let runtime;
let env;
let supervisorIdentity;
let watch;

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
    if (result.status !== 0) throw new Error(`Managed helper failed (${result.status ?? result.error?.code}): ${result.stderr?.trim() || result.error?.message || 'no diagnostic'}`);
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

const relayPath = `\\\\.\\pipe\\hapi-codex-app-tools-${config.ownerTag}`;
function prepareRuntime() {
    runtime = parseOutput(script('resolve-runtime.ps1', ['-Config', path.join(root, 'config.json')]));
    supervisorIdentity = identify(process.pid);
    env = { ...process.env };
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
}

function identify(processId) {
    return parseOutput(script('process-info.ps1', ['-ProcessId', String(processId)]));
}

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
        status,
        failure,
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
    const destination = path.join(stateDirectory, 'managed.json');
    // Windows readers such as Get-Content can briefly hold the old file without
    // delete sharing. Keep atomic replacement, but allow the reader to finish.
    for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(temporary, destination); break; }
        catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
}

function stopRequested() {
    const request = path.join(stateDirectory, 'stop');
    if (!fs.existsSync(request)) return false;
    fs.rmSync(request, { force: true });
    return true;
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
        const probe = await new Promise(resolve => {
            const ws = new WebSocket(config.websocketUrl);
            const close = () => {
                clearTimeout(timer);
                ws.onerror = () => {};
                ws.onclose = null;
                ws.onmessage = null;
                ws.close();
            };
            const timer = setTimeout(() => { close(); resolve(null); }, 1500);
            ws.onerror = () => { close(); resolve(null); };
            ws.onclose = () => { clearTimeout(timer); resolve(null); };
            ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hapi_windows_managed', version: '1' }, capabilities: { experimentalApi: true } } }));
            ws.onmessage = event => {
                let message;
                try { message = JSON.parse(event.data); } catch { close(); resolve(null); return; }
                if (message.id !== 1) return;
                clearTimeout(timer);
                if (message.result) ws.send(JSON.stringify({ method: 'initialized' }));
                // Keep the probe connected until its server/client TCP pair is
                // checked. Listener state alone is unreliable on some Windows builds.
                resolve({ result: message.result ?? { rejected: true }, close });
            };
        });
        if (probe) {
            try {
                const { result } = probe;
                const owner = parseOutput(script('process-info.ps1', ['-ProcessId', String(daemon.pid), '-ListeningPort', url.port, '-PeerProcessId', String(process.pid)]));
                const checks = {
                    endpoint: owner.listening || owner.probeConnection,
                    process: owner.pid === daemon.pid && owner.ownerSid === config.ownerSid && path.resolve(owner.executable ?? '').toLowerCase() === path.resolve(runtime.cliExe).toLowerCase(),
                    platform: result.platformFamily === 'windows',
                    home: typeof result.codexHome === 'string' && path.resolve(result.codexHome).toLowerCase() === path.resolve(config.codexHome).toLowerCase()
                };
                log({ event: 'daemon-identity-check', pid: daemon.pid, checks, endpointStates: owner.endpointStates, probeConnection: owner.probeConnection });
                if (Object.values(checks).some(value => !value)) throw new Error(`Backend identity mismatch: ${Object.keys(checks).filter(key => !checks[key]).join(', ')}`);
                if (stopping || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Owned daemon exited during verification');
                daemonIdentity = owner;
                log({ event: 'daemon-initialize-verified', pid: daemon.pid, platformFamily: result.platformFamily });
                return;
            } finally { probe.close(); }
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Owned daemon initialization timed out');
}

async function startDaemon() {
    daemonReady = false;
    daemonIdentity = null;
    status = restarting ? 'restarting' : 'starting';
    save();
    await requireFreePort();
    daemon = launch(runtime.cliExe, [
        'app-server', '--listen', config.websocketUrl,
        '--analytics-default-enabled',
        '-c', 'features.code_mode_host=true',
        '-c', 'features.prefer_mxc=true',
        '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'
    ], env);
    const started = Date.now();
    log({ event: 'daemon-start', pid: daemon.pid });
    daemon.once('exit', async code => {
        log({ event: 'daemon-exit', code });
        const wasReady = daemonReady;
        daemonReady = false;
        target = null;
        save();
        if (!wasReady) return;
        if (stopping || restarting) return;
        if (Date.now() - started >= 60000) restartCount = 0;
        if (++restartCount > 3) return shutdown('daemon-restart-limit', new Error('Daemon repeatedly exited before one minute of uptime'));
        restarting = true;
        status = 'restarting';
        save();
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (stopping) return;
        try {
            await startDaemon();
        } catch (error) {
            await shutdown('daemon-restart-failed', error);
        } finally {
            restarting = false;
        }
    });
    await initializeOwnedDaemon();
    daemonReady = true;
    status = 'ready';
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

async function shutdown(reason, error) {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    let exitCode = error ? 1 : 0;
    const saveStoppedState = () => {
        try { save(); }
        catch (error) {
            exitCode = 1;
            log({ event: 'state-save-failed', message: error.message });
        }
    };
    failure = error ? { reason, message: error.message, code: error.code } : undefined;
    status = error ? 'failed' : 'stopping';
    daemonReady = false;
    target = null;
    saveStoppedState();
    log({ event: 'supervisor-stop', reason, exitCode, failure });
    for (const socket of sockets) socket.destroy();
    relay.close();
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    }
    daemonIdentity = null;
    desktopIdentity = null;
    status = error ? 'failed' : 'stopped';
    saveStoppedState();
    fs.writeFileSync(path.join(stateDirectory, 'stopped.json'), JSON.stringify({ at: new Date().toISOString(), reason, exitCode, failure }));
    process.exit(exitCode);
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

async function poll() {
    if (watchBusy || stopping) return;
    watchBusy = true;
    try {
        if (stopRequested()) return await shutdown('requested');
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
    } catch (error) {
        log({ event: 'watch-failed', message: error.message });
    } finally {
        watchBusy = false;
    }
}

process.on('SIGTERM', () => shutdown('signal'));
process.on('uncaughtException', error => shutdown('uncaught-exception', error));
process.on('unhandledRejection', error => shutdown('unhandled-rejection', error instanceof Error ? error : new Error(String(error))));
relay.once('error', error => shutdown('relay-unavailable', error));
relay.listen(relayPath, async () => {
    try {
        fs.rmSync(path.join(stateDirectory, 'stopped.json'), { force: true });
        save();
        if (stopRequested()) return await shutdown('requested');
        prepareRuntime();
        await startDaemon();
        startDesktop();
        watch = setInterval(poll, 3000);
    } catch (error) {
        log({ event: 'startup-error', message: error.message, code: error.code });
        await shutdown('startup-failed', error);
    }
});
