# HAPI service doctor for Windows

Run the doctor from the Windows account that owns the deployment. It reads the selected runtime and checks its scheduled tasks, Windows Runner control listener, Native daemon and Desktop tools connection, WSL user units, HAPI Hub health, and Tailscale Serve listeners and targets. When WSL reports the configured distribution stopped, the doctor skips its unit probes.

    .\service-doctor.exe check
    .\service-doctor.exe info --root 'D:\Services\HAPI'
    .\service-doctor.exe watch --component hub --component tailscale --interval 5
    .\service-doctor.exe check --json
    .\service-doctor.exe update wsl-codex
    .\service-doctor.exe update tailscale

- `check` is the default. It reports a single snapshot.
- `info` adds maintenance paths, task names, the configured WSL distribution and user, and endpoint authorities. Review the local inventory before sharing it.
- `watch` repeats the snapshot until Ctrl+C. The default wait between completed snapshots is 10 seconds. Set `--interval` to 1–3600 seconds.
- `--root` selects the Windows runtime. The doctor otherwise searches beside the executable and its parent directories for an installed runtime, then falls back to `%LOCALAPPDATA%\HAPI`.
- `update wsl-codex` runs the official CLI updater as the distribution and user in `services.json`. When needed, it installs and pins that CLI build for the managed daemon, which can interrupt running turns. It checks the running version afterwards. A matching daemon keeps running.
- `update tailscale` opens the Windows Tailscale CLI updater for the installed track. Its own confirmation and privilege requirements apply.
- Repeat `--component` to select any of `runner`, `native`, `desktop`, `wsl`, `hub`, and `tailscale`.

The doctor uses the installed Native inspector. A portable copy also looks for a current `windows-native\inspect.ps1` beside the executable. The current inspector can read an older installation directly using its installed runtime as the deployment root. `--component native` uses the fast backend probe when the inspector supports it.

## Output

Successful probes report the evidence they observed. A Tailscale Web probe can report HTTP 401 or 403 when the application is reachable and requires authorization. The Hub probe checks the contents of the HAPI health response. A configured service that fails a probe is reported as `down`. An unavailable check means the doctor could not obtain the necessary evidence. An idle Desktop connection or an unselected installation component can appear as `optional`.

Desktop's current backend connection, tools pipe, and tools relay have separate checks. A closed Desktop is optional. A running Desktop expected to share the Native backend is degraded when its backend connection is missing. The two Store routing checks compare the effective stored User and Machine settings with the configured backend and flag forced CLI mode. They print the result without the stored values.

Single snapshots return exit code **0** when all required checks passed, **1** when a service is degraded, or **2** when required evidence is unavailable or invocation fails. Check actions give the next place to look.

`--json` emits one object per snapshot. Watch emits one object per line. Each complete object has `schemaVersion`, `checkedAtUtc`, `status`, `exitCode`, and `checks`. Each check has `component`, `check`, `status`, `detail`, and an `action` where applicable. Only `info` includes `localInventory`. The reports omit raw logs, environment values, command lines, and URL credentials, queries, or fragments.

Info and watch report verified daemon, supervisor, and Desktop identities in `processes` when available. Each identity includes `pid` and `startedAtUtc`. Watch also includes a `processChanges` list, with each replacement compared to the last verified identity for that role. This detects PID reuse and preserves the previous identity through a sample where the process was unobservable.

## Build from source

With a Windows Rust toolchain, run the following from this directory.

    $env:CARGO_TARGET_DIR = Join-Path $env:TEMP 'hapi-service-doctor-build'
    cargo build --locked --release

The executable is in the target directory under `release\service-doctor.exe`.
