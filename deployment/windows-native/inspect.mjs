import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Read-only diagnostics: never sends a thread, turn, queue, settings or tool request.
const [mode, target, expectedHome, expectedPid, expectedSupervisorScript, expectedNode, expectedCli] = process.argv.slice(2);

function executableMatches(actual, expected) {
    if (!actual || !expected) return false;
    const comparable = value => path.win32.resolve(value).toLowerCase();
    if (comparable(actual) === comparable(expected)) return true;
    try { return comparable(fs.realpathSync.native(actual)) === comparable(fs.realpathSync.native(expected)); }
    catch { return false; }
}

function finish(value, ok) {
    const line = JSON.stringify(value).replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    // The diagnostic ends even if a server never responds to the close frame.
    process.stdout.write(line + '\n', () => process.exit(ok ? 0 : 1));
}

if (mode === 'bundle') {
    try {
        const bytes = fs.readFileSync(target);
        const websocketOverrideMarker = bytes.includes(Buffer.from('CODEX_APP_SERVER_WS_URL'));
        const desktopToolsPipeMarker = bytes.includes(Buffer.from('codex-app-tools-'));
        finish({ websocketOverrideMarker, desktopToolsPipeMarker,
            meaning: 'Markers are evidence of code presence, not runtime compatibility.' }, websocketOverrideMarker);
    } catch {
        finish({ ok: false, code: 'BUNDLE_UNREADABLE' }, false);
    }
} else if (mode === 'native') {
    let socket;
    let timer;
    let ended = false;
    const done = (value, ok) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        socket?.close();
        finish(value, ok);
    };
    try {
        const address = new URL(target);
        if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || !address.port ||
            address.username || address.password || address.search || address.hash ||
            address.pathname !== '/' || !expectedHome) throw new Error();
        if (typeof WebSocket !== 'function') {
            done({ ok: false, code: 'NODE_GLOBAL_WEBSOCKET_MISSING' }, false);
        } else {
            socket = new WebSocket(target);
            timer = setTimeout(() => {
                done({ ok: false, code: 'INITIALIZE_TIMEOUT' }, false);
            }, 5000);
            socket.onerror = () => done({ ok: false, code: 'CONNECT_FAILED' }, false);
            socket.onclose = () => { if (!ended) done({ ok: false, code: 'CLOSED_BEFORE_INITIALIZE' }, false); };
            socket.onopen = () => socket.send(JSON.stringify({
                id: 1, method: 'initialize', params: {
                    clientInfo: { name: 'hapi-migration-inspect', version: '1' },
                    capabilities: { experimentalApi: true }
                }
            }));
            socket.onmessage = event => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.id !== 1) return;
                    if (!message.result) return done({ ok: false, code: 'INITIALIZE_REJECTED' }, false);
                    const result = message.result;
                    const homeMatches = typeof result.codexHome === 'string' &&
                        path.win32.resolve(result.codexHome).toLowerCase() === path.win32.resolve(expectedHome).toLowerCase();
                    const windows = result.platformFamily === 'windows';
                    socket.send(JSON.stringify({ method: 'initialized' }));
                    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                        path.join(path.dirname(fileURLToPath(import.meta.url)), 'process-info.ps1'),
                        '-ListeningPort', address.port, '-PeerProcessId', String(process.pid)];
                    if (Number(expectedPid)) args.push('-ProcessId', expectedPid);
                    if (expectedSupervisorScript) args.push('-ExpectedSupervisorScript', expectedSupervisorScript, '-ExpectedBackendUrl', target);
                    const helper = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args,
                        { windowsHide: true, encoding: 'utf8', timeout: 15000 });
                    const endpoint = helper.status === 0 ? JSON.parse(helper.stdout.replace(/^\uFEFF/, '')) : null;
                    const endpointOwned = endpoint?.probeConnection === true && !!endpoint.pid;
                    if (endpoint && expectedNode) endpoint.supervisorExecutableMatches = executableMatches(endpoint.supervisor?.executable, expectedNode);
                    if (endpoint && expectedCli) endpoint.daemonExecutableMatches = executableMatches(endpoint.executable, expectedCli);
                    const ok = windows && homeMatches && endpointOwned;
                    const code = !windows || !homeMatches ? 'IDENTITY_MISMATCH' :
                        endpointOwned ? 'INITIALIZE_VERIFIED' : 'ENDPOINT_OWNER_UNVERIFIED';
                    done({ ok, platformFamily: windows ? 'windows' : 'unexpected', initialized: true,
                        homeMatches, endpointOwned, endpoint, code }, ok);
                } catch {
                    done({ ok: false, code: 'INVALID_INITIALIZE_RESPONSE' }, false);
                }
            };
        }
    } catch {
        done({ ok: false, code: 'USE_LOOPBACK_WS_AND_EXPECTED_HOME' }, false);
    }
} else {
    finish({ ok: false, code: 'USE_BUNDLE_OR_NATIVE_MODE' }, false);
}
