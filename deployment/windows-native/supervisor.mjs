import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { config, daemonArguments, desktopEnvironment, powershell, prepareRuntime, relayPath, root, script } from './runtime.mjs';

const stateDirectory = path.join(root, 'state');
const watchInterval = 3000;
const healthInterval = 15000;
const healthRetry = 9000;
const missedProbesLimit = 3;
const probeTimeout = 4000;
const resumeGap = 15000;
const targetIdleInterval = 15000;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const samePath = (left, right) => typeof left === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const isRunning = child => child?.pid && child.exitCode === null && child.signalCode === null;
fs.mkdirSync(stateDirectory, { recursive: true });

const children = new Set();
const sockets = new Set();
let daemon;
let daemonLaunch;
let daemonIdentity;
let desktopHint;
let desktop;
let desktopIdentity;
let supervisorIdentity;
let target;
let targetUncertain = false;
let resolving;
let relayRetryAt = 0;
let lastTargetCheck = 0;
let nextTargetCheck = 0;
let nextHealthCheck = 0;
let lastHealthTick = 0;
let healthGeneration = 0;
let missedProbes = 0;
let healthBusy = false;
let daemonReady = false;
let restarting = false;
let restartCount = 0;
let stopping = false;
let status = 'starting';
let failure;
let watch;
let snapshotRetry;
let lastSnapshotFailure = 0;

function log(event) {
    try {
        fs.appendFileSync(path.join(stateDirectory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
    } catch {}
}

function track(child) {
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
}

function launch(kind, executable, args, env) {
    let stderr = 'ignore';
    if (kind === 'daemon') {
        const file = path.join(stateDirectory, 'daemon-stderr.log');
        if (fs.existsSync(file) && fs.statSync(file).size > 4 * 1024 * 1024) fs.renameSync(file, file + '.previous');
        stderr = fs.openSync(file, 'a');
    }
    const child = track(spawn(executable, args, {
        env,
        cwd: config.codexHome,
        windowsHide: true,
        stdio: ['ignore', 'ignore', stderr]
    }));
    if (typeof stderr === 'number') fs.closeSync(stderr);
    child.once('error', error => log({ event: 'child-error', kind, code: error.code }));
    return child;
}

function query(name, args) {
    return new Promise((resolve, reject) => {
        const child = track(spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, name), ...args, '-Utf8Output'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
        }));
        let output = '';
        let failure;
        const timer = setTimeout(() => {
            failure = new Error(name + ' timed out');
            child.kill();
        }, 30000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.once('error', error => { failure = error; });
        child.once('close', code => {
            clearTimeout(timer);
            if (failure || code !== 0) return reject(failure ?? new Error(name + ' did not complete'));
            try { resolve(JSON.parse(output.replace(/^\uFEFF/, ''))); }
            catch { reject(new Error(name + ' returned invalid JSON')); }
        });
    });
}

function save(retries = 2) {
    const value = {
        status,
        failure,
        supervisor: supervisorIdentity,
        daemon: daemonIdentity,
        daemonLaunch,
        desktop: target?.desktop ?? desktopIdentity,
        ownedDesktop: desktopIdentity,
        launchDesktop: config.launchDesktop !== false,
        url: config.websocketUrl,
        toolsRelay: relayPath,
        toolsRelayReady: relay.listening,
        toolsPipeReady: relay.listening && !!target?.pipe,
        daemonReady,
        desktopBackendConnected: target?.backendConnected === true,
        at: new Date().toISOString()
    };
    const temporary = path.join(stateDirectory, 'managed.json.tmp');
    const destination = path.join(stateDirectory, 'managed.json');
    // Windows readers can briefly hold the old file without delete sharing.
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
        fs.renameSync(temporary, destination);
        clearTimeout(snapshotRetry);
        snapshotRetry = undefined;
    } catch (error) {
        const now = Date.now();
        if (now - lastSnapshotFailure >= 30000) {
            lastSnapshotFailure = now;
            log({ event: 'state-save-failed', code: error.code });
        }
        if (!stopping && !snapshotRetry && retries > 0 && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
            snapshotRetry = setTimeout(() => {
                snapshotRetry = undefined;
                save(retries - 1);
            }, 250);
        }
    }
}

function stopRequested() {
    const request = path.join(stateDirectory, 'stop');
    if (!fs.existsSync(request)) return false;
    fs.rmSync(request, { force: true });
    return true;
}

async function findTarget(onDemand = false) {
    if (!daemonReady || stopping) return null;
    if (resolving) return resolving;
    const now = Date.now();
    const freshFor = !targetUncertain && target?.pipe && target?.backendConnected ? 1500 : 6000;
    if (now < nextTargetCheck && (!onDemand || now - lastTargetCheck < freshFor)) return targetUncertain ? null : target;
    const selectedDaemon = daemon;
    lastTargetCheck = now;
    const args = ['-OwnerSid', config.ownerSid, '-BackendPort', backendUrl.port, '-BackendPid', String(selectedDaemon.pid)];
    if (desktopHint) args.push('-ExpectedDesktopExe', desktopHint);
    resolving = (async () => {
        try {
            const found = await query('find-tools-pipe.ps1', args);
            if (stopping || daemon !== selectedDaemon || !daemonReady) return null;
            if (found?.pipe && target?.pipe !== found.pipe) log({ event: 'tools-pipe-bound', processId: found.processId });
            target = found;
            targetUncertain = false;
            nextTargetCheck = Date.now() + (found?.desktopProcessId && (!found.pipe || !found.backendConnected) ? 6000 : targetIdleInterval);
            save();
            return target;
        } catch (error) {
            if (daemon === selectedDaemon && daemonReady) {
                targetUncertain = true;
                nextTargetCheck = Date.now() + targetIdleInterval;
                log({ event: 'tools-discovery-unavailable', message: error.message });
            }
            return null;
        }
    })().finally(() => { resolving = null; });
    return resolving;
}

async function requireFreePort() {
    if (backendUrl.protocol !== 'ws:' || backendUrl.hostname !== '127.0.0.1' || !backendUrl.port) throw new Error('Only explicit loopback backend ports are supported');
    await new Promise((resolve, reject) => {
        const check = net.createServer();
        check.once('error', reject);
        check.listen(Number(backendUrl.port), backendUrl.hostname, () => check.close(resolve));
    });
}

function probeDaemon(timeout) {
    const started = Date.now();
    return new Promise(resolve => {
        const socket = new WebSocket(config.websocketUrl);
        let finished = false;
        const close = () => { socket.close(); };
        const complete = (reply, keepOpen = false) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.onerror = () => {};
            socket.onclose = null;
            socket.onmessage = null;
            socket.onopen = null;
            if (!keepOpen) close();
            const elapsed = Date.now() - started;
            resolve({ reply, close, interrupted: elapsed < 0 || elapsed > timeout + 2000 });
        };
        const timer = setTimeout(() => complete(null), timeout);
        socket.onerror = () => complete(null);
        socket.onclose = () => complete(null);
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hapi_windows_managed', version: '1' }, capabilities: { experimentalApi: true } } }));
        socket.onmessage = event => {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message?.id !== 1) return;
            if (message.result) socket.send(JSON.stringify({ method: 'initialized' }));
            // Keep initialized probes open for the reverse TCP tuple at startup.
            complete(message, !!message.result);
        };
    });
}

function isExpectedResult(result) {
    return result?.platformFamily === 'windows' && samePath(result.codexHome, config.codexHome);
}

function matchesDaemon(owner, selectedDaemon, executable) {
    return !!owner && owner.pid === selectedDaemon.pid && owner.ownerSid === config.ownerSid && samePath(owner.executable, executable);
}

async function initializeOwnedDaemon(selectedDaemon, executable) {
    const deadline = Date.now() + 20000;
    do {
        if (stopping || !isRunning(selectedDaemon)) throw new Error('Owned daemon exited');
        const probe = await probeDaemon(1500);
        if (probe.reply) {
            try {
                const result = probe.reply.result;
                const owner = await query('process-info.ps1', ['-ProcessId', String(selectedDaemon.pid), '-ListeningPort', backendUrl.port, '-PeerProcessId', String(process.pid)]);
                const checks = {
                    endpoint: owner.listening || owner.probeConnection,
                    process: matchesDaemon(owner, selectedDaemon, executable),
                    platform: result?.platformFamily === 'windows',
                    home: samePath(result?.codexHome, config.codexHome)
                };
                log({ event: 'daemon-identity-check', pid: selectedDaemon.pid, checks, endpointStates: owner.endpointStates, probeConnection: owner.probeConnection });
                if (Object.values(checks).some(value => !value)) throw new Error('Backend identity mismatch: ' + Object.keys(checks).filter(key => !checks[key]).join(', '));
                if (stopping || !isRunning(selectedDaemon)) throw new Error('Owned daemon exited during verification');
                daemonIdentity = owner;
                log({ event: 'daemon-initialize-verified', pid: selectedDaemon.pid, platformFamily: result.platformFamily });
                return;
            } finally { probe.close(); }
        }
        await delay(150);
    } while (Date.now() < deadline);
    throw new Error('Owned daemon initialization timed out');
}

async function startDaemon() {
    daemonReady = false;
    daemonLaunch = null;
    daemonIdentity = null;
    status = restarting ? 'restarting' : 'starting';
    save();
    await requireFreePort();
    if (stopping) return;
    const { runtime, env, daemonConfigOverrides } = prepareRuntime();
    const selectedDaemon = launch('daemon', runtime.cliExe, daemonArguments(daemonConfigOverrides), env);
    const started = Date.now();
    daemon = selectedDaemon;
    desktopHint = runtime.desktopExe;
    daemonLaunch = { pid: selectedDaemon.pid, executable: runtime.cliExe };
    save();
    log({ event: 'daemon-start', pid: selectedDaemon.pid });
    selectedDaemon.once('exit', async code => {
        log({ event: 'daemon-exit', code });
        if (stopping || daemon !== selectedDaemon) return;
        const wasReady = daemonReady;
        daemonReady = false;
        target = null;
        save();
        if (!wasReady || restarting) return;
        if (Date.now() - started >= 60000) restartCount = 0;
        if (++restartCount > 3) return shutdown('daemon-restart-limit', new Error('Daemon repeatedly exited before one minute of uptime'));
        restarting = true;
        status = 'restarting';
        save();
        await delay(watchInterval);
        if (stopping) return;
        try { await startDaemon(); }
        catch (error) { await shutdown('daemon-restart-failed', error); }
        finally { restarting = false; }
    });
    await initializeOwnedDaemon(selectedDaemon, runtime.cliExe);
    daemonReady = true;
    missedProbes = 0;
    targetUncertain = false;
    nextHealthCheck = Date.now() + healthInterval;
    lastTargetCheck = 0;
    nextTargetCheck = 0;
    status = 'ready';
    save();
}

async function checkHealth(now) {
    const gap = now - lastHealthTick;
    lastHealthTick = now;
    if (gap < 0 || gap > resumeGap) {
        healthGeneration++;
        missedProbes = 0;
        nextHealthCheck = now + healthInterval;
    }
    if (healthBusy || stopping || !daemonReady || now < nextHealthCheck) return;
    const selectedDaemon = daemon;
    const generation = healthGeneration;
    const current = () => !stopping && daemonReady && daemon === selectedDaemon && isRunning(selectedDaemon) && generation === healthGeneration;
    healthBusy = true;
    try {
        const probe = await probeDaemon(probeTimeout);
        probe.close();
        if (!current()) return;
        if (probe.interrupted || probe.reply) {
            if (probe.reply && !isExpectedResult(probe.reply.result)) log({ event: 'daemon-health-unexpected-reply', pid: selectedDaemon.pid });
            missedProbes = 0;
            nextHealthCheck = Date.now() + healthInterval;
            return;
        }
        missedProbes = Math.min(missedProbes + 1, missedProbesLimit);
        nextHealthCheck = Date.now() + healthRetry;
        log({ event: 'daemon-health-probe-missed', pid: selectedDaemon.pid, attempts: missedProbes });
        if (missedProbes < missedProbesLimit) return;

        // Reconfirm the child identity and give a busy backend a longer final probe.
        const owned = await query('process-info.ps1', ['-ProcessId', String(selectedDaemon.pid)]);
        if (!current() || !matchesDaemon(owned, selectedDaemon, daemonLaunch.executable) || owned.started !== daemonIdentity.started) return;
        const finalProbe = await probeDaemon(10000);
        finalProbe.close();
        if (!current()) return;
        if (finalProbe.interrupted || finalProbe.reply) {
            missedProbes = 0;
            nextHealthCheck = Date.now() + healthInterval;
            return;
        }
        log({ event: 'daemon-health-restart', pid: selectedDaemon.pid });
        selectedDaemon.kill();
    } catch (error) {
        missedProbes = 0;
        log({ event: 'daemon-health-unavailable', message: error.message });
        nextHealthCheck = Date.now() + healthInterval;
    } finally { healthBusy = false; }
}

function startDesktop() {
    if (isRunning(desktop)) return;
    try {
        const { runtime, env } = prepareRuntime({ requireDesktop: true });
        if (!runtime.desktopExe) throw new Error('Installed Desktop executable unavailable');
        const child = launch('desktop', runtime.desktopExe, [], desktopEnvironment(env));
        desktop = child;
        child.once('spawn', async () => {
            log({ event: 'desktop-start', pid: child.pid });
            try {
                const identity = await query('process-info.ps1', ['-ProcessId', String(child.pid)]);
                if (stopping || desktop !== child || !isRunning(child)) return;
                if (matchesDaemon(identity, child, runtime.desktopExe)) {
                    desktopIdentity = identity;
                    save();
                }
            } catch (error) { log({ event: 'desktop-identity-unavailable', message: error.message }); }
        });
        child.once('exit', () => {
            if (desktop !== child || stopping) return;
            desktopIdentity = null;
            nextTargetCheck = 0;
            save();
        });
    } catch (error) { log({ event: 'desktop-launch-unavailable', message: error.message }); }
}

async function shutdown(reason, error) {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    clearTimeout(snapshotRetry);
    let exitCode = error ? 1 : 0;
    failure = error ? { reason, message: error.message, code: error.code } : undefined;
    status = error ? 'failed' : 'stopping';
    daemonReady = false;
    target = null;
    save();
    log({ event: 'supervisor-stop', reason, exitCode, failure });
    for (const socket of sockets) socket.destroy();
    relay.close();
    for (const child of children) {
        if (isRunning(child)) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    }
    // Preserve launch evidence for wrapper cleanup if taskkill did not finish.
    daemonIdentity = null;
    desktopIdentity = null;
    status = error ? 'failed' : 'stopped';
    save();
    try { fs.writeFileSync(path.join(stateDirectory, 'stopped.json'), JSON.stringify({ at: new Date().toISOString(), reason, exitCode, failure })); }
    catch (error) {
        exitCode = 1;
        log({ event: 'stop-receipt-save-failed', code: error.code });
    }
    process.exit(exitCode);
}

const relay = net.createServer(async client => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => {});
    client.pause();
    try {
        const found = await findTarget(true);
        if (!found?.pipe || !found.backendConnected || client.destroyed) return client.destroy();
        const upstream = net.connect(found.pipe);
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        upstream.on('error', () => {
            if (target === found && !stopping) {
                target = null;
                nextTargetCheck = 0;
                save();
            }
            client.destroy();
        });
        client.once('close', () => upstream.destroy());
        upstream.once('connect', () => {
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
        });
    } catch (error) {
        client.destroy();
        log({ event: 'tools-relay-connection-failed', message: error.message });
    }
});

function relayUnavailable(error) {
    relayRetryAt = Date.now() + targetIdleInterval;
    log({ event: 'tools-relay-unavailable', code: error.code });
    if (!stopping) save();
}

relay.on('error', relayUnavailable);
relay.on('listening', () => { if (!stopping) save(); });

function poll() {
    if (stopping) return;
    if (stopRequested()) return shutdown('requested');
    const now = Date.now();
    if (!relay.listening && now >= relayRetryAt) {
        relayRetryAt = now + targetIdleInterval;
        try { relay.listen(relayPath); }
        catch (error) { relayUnavailable(error); }
    }
    if (daemonReady && fs.existsSync(path.join(stateDirectory, 'open'))) {
        fs.rmSync(path.join(stateDirectory, 'open'), { force: true });
        if (config.launchDesktop !== false) startDesktop();
    }
    void checkHealth(now);
    void findTarget().catch(error => log({ event: 'watch-failed', message: error.message }));
}

let backendUrl;
process.on('SIGTERM', () => shutdown('signal'));
process.on('uncaughtException', error => shutdown('uncaught-exception', error));
process.on('unhandledRejection', error => shutdown('unhandled-rejection', error instanceof Error ? error : new Error(String(error))));
(async () => {
    try {
        fs.rmSync(path.join(stateDirectory, 'stopped.json'), { force: true });
        save();
        if (stopRequested()) return await shutdown('requested');
        backendUrl = new URL(config.websocketUrl);
        supervisorIdentity = script('process-info.ps1', ['-ProcessId', String(process.pid)]);
        lastHealthTick = Date.now();
        watch = setInterval(poll, watchInterval);
        poll();
        await startDaemon();
        if (!stopping && config.launchDesktop !== false) startDesktop();
    } catch (error) {
        log({ event: 'startup-error', message: error.message, code: error.code });
        await shutdown('startup-failed', error);
    }
})();
