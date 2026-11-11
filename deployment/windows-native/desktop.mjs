import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, desktopEnvironment, prepareRuntime, root, script } from './runtime.mjs';

function log(event) {
    fs.appendFileSync(path.join(root, 'state', 'desktop-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

try {
    if (config.launchDesktop !== false) throw new Error('An independent Desktop requires a headless backend');
    const { runtime, env } = prepareRuntime();
    const desktop = spawn(runtime.desktopExe, [], {
        env: desktopEnvironment(env),
        cwd: config.codexHome,
        windowsHide: true,
        stdio: 'ignore'
    });
    desktop.once('spawn', () => {
        log({ event: 'desktop-start', pid: desktop.pid });
        try {
            const identity = script('process-info.ps1', ['-ProcessId', String(desktop.pid)]);
            if (identity.ownerSid === config.ownerSid && identity.executable?.toLowerCase() === runtime.desktopExe.toLowerCase()) {
                fs.writeFileSync(path.join(root, 'state', 'desktop-managed.json'), JSON.stringify(identity));
            }
        } catch (error) { log({ event: 'desktop-identity-unavailable', message: error.message }); }
    });
    desktop.once('error', error => {
        log({ event: 'desktop-launch-failed', code: error.code });
        process.exitCode = 1;
    });
    desktop.once('exit', (code, signal) => {
        log({ event: 'desktop-exit', code, signal });
        process.exitCode = code ?? 1;
    });
} catch (error) {
    log({ event: 'desktop-startup-failed', message: error.message });
    process.exitCode = 1;
}
