import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Read-only diagnostics: never sends a thread, turn, queue, settings or tool request.
const [mode, target, expectedHome, expectedPid] = process.argv.slice(2);
function finish(value, ok) {
    process.stdout.write(JSON.stringify(value) + '\n');
    process.exitCode = ok ? 0 : 1;
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
        if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' ||
            address.username || address.password || address.search || address.hash ||
            address.pathname !== '/' || !expectedHome) throw new Error();
        if (typeof WebSocket !== 'function') {
            done({ ok: false, code: 'NODE_GLOBAL_WEBSOCKET_MISSING' }, false);
        } else {
            socket = new WebSocket(target);
            timer = setTimeout(() => {
                done({ ok: false, code: 'INITIALIZE_TIMEOUT' }, false);
                socket.terminate?.();
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
                    let endpointOwned;
                    if (expectedPid) {
                        const helper = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
                            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(fileURLToPath(import.meta.url)), 'process-info.ps1'),
                            '-ProcessId', expectedPid, '-ListeningPort', address.port, '-PeerProcessId', String(process.pid)
                        ], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
                        const owner = helper.status === 0 ? JSON.parse(helper.stdout.replace(/^\uFEFF/, '')) : null;
                        endpointOwned = owner?.pid === Number(expectedPid) && !!(owner?.listening || owner?.probeConnection);
                    }
                    const ok = windows && homeMatches && (!expectedPid || endpointOwned);
                    done({ ok, platformFamily: windows ? 'windows' : 'unexpected',
                        homeMatches, endpointOwned, code: ok ? 'INITIALIZE_VERIFIED' : 'IDENTITY_MISMATCH' }, ok);
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
