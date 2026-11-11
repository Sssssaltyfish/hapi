# Windows Desktop shared backend

The native app-server and Codex Desktop have separate tasks in Windows Task Scheduler. Both tasks use the deployment owner's interactive token with run level `Limited` and start at that user's Windows logon. The backend runs with `launchDesktop: false`, which lets Desktop close or reopen independently. The Desktop task waits for the daemon and opens the app against the shared loopback endpoint. A named pipe connects the backend to Desktop tools while Desktop is connected.

Both tasks run through Windows' system `wscript.exe`, `task-bootstrap.js`, `task-launcher.ps1` and `task-lifetime.ps1`. The launcher starts the PowerShell entry point without a console and tracks its lifetime. Ending the backend task requests a clean supervisor shutdown. Ending the Desktop task stops its launcher and leaves the interactive app available.

## Install and switch

Use an independent Windows PowerShell window in the deployment owner's interactive session. The Codex Desktop package, its installed CLI, a Codex home, and a Node executable with a global `WebSocket` must already be present. Copy `windows-native` and the three shared launcher files from `deployment` into a private runtime directory, with the shared files beside `windows-native`.

Run these commands in the deployed `windows-native` directory. `17844` is the default loopback port. If you choose another port or Codex home, pass the same values to `inspect.ps1` and `install.ps1`. The installer accepts `-McpNodeExe` and `-BrowserNodeExe` for separate Node executables. It discovers Desktop and the CLI from the existing installation.

```powershell
$node = (Get-Command node.exe -CommandType Application).Source
& .\inspect.ps1 -NodeExe $node
& .\install.ps1 -NodeExe $node
```

Continue after the preflight reports `ok: true`. The installer stages both tasks disabled and saves the current user endpoint locally. Fully exit the original Codex Desktop, then run the switch from the independent PowerShell window.

```powershell
& .\switch.ps1
& .\inspect.ps1 -NodeExe $node -CheckRunning -RequireDesktop
```

The switch enables and starts the backend, waits for its verified loopback app-server, and then starts the Desktop task. It checks that the new Desktop owns the tools pipe and connects to that backend before setting the user environment variable `CODEX_APP_SERVER_WS_URL`. Its result is in `state/switch-result.json`. A failure after the cutover begins invokes rollback. A preflight failure leaves the existing tasks and Desktop in place.

To have Windows close the original processes as part of a scheduled switch, run `inspect.ps1 -NodeExe $node` and identify the original `ChatGPT.exe` and its `codex.exe` app-server from their executable paths and parent PIDs. Supply each PID and its UTC creation timestamp. The task runs after 30 seconds. The following identities are fictional.

```powershell
& .\schedule-switch.ps1 -OldDesktopPid 4120 -OldDesktopStarted '2030-01-15T09:30:00.0000000Z' `
  -OldBackendPid 4188 -OldBackendStarted '2030-01-15T09:30:03.0000000Z'
```

`inspect.ps1 -CheckRunning` checks the backend by itself. Add `-RequireDesktop` to verify the tools pipe and the Desktop connection. Keep `config.json` and `state/` local. The installer captures the current process proxy environment in the private config, and the state can contain machine paths and process identities.

## Update an existing managed backend

Run the staged `update.ps1` from a separate process that can stay alive while the native backend restarts. Copy the candidate scripts to a different directory from the live deployment. For an example runtime under the local application data directory, run the following from the candidate directory with the current supervisor identity.

```powershell
$nativeRoot = Join-Path $env:LOCALAPPDATA 'HAPI\windows-native'
$supervisor = (Get-Content -LiteralPath "$nativeRoot\state\managed.json" -Raw | ConvertFrom-Json).supervisor
& .\update.ps1 -DeploymentRoot $nativeRoot `
  -ExpectedSupervisorPid $supervisor.pid -ExpectedSupervisorStarted $supervisor.started
```

The updater validates the supervisor identity, requests a clean stop, waits for the backend and task to exit, replaces the scripts, and starts the backend task. Provide both `-CandidateConfig` and `-CandidateTaskXml` when updating the private config and task definition together. Otherwise it refreshes the backend task's retry settings through `configure-task.ps1`. It verifies that the daemon and supervisor share the expected interactive session. The result is in `state/update-result.json`.

If an update fails after shutdown begins, the updater restores the previous scripts and any changed config or task definition, then restarts the backend. If recovery fails, it keeps `state/update-backup` for inspection.

## Roll back the initial switch

Run `rollback.ps1` in the deployed `windows-native` directory from an independent Windows PowerShell window under the deployment owner. Rollback disables the managed tasks, stops verified managed processes, removes the task registrations, and restores the saved user endpoint if the managed value is still in use. It reopens Codex Desktop after an active cutover if no Desktop instance is already open. Successful rollback removes the native config and saved endpoint receipt. The Codex home and diagnostic logs remain available.

## Identity and recovery

`run.ps1` takes an exclusive file lock across Windows sessions and waits for `supervisor.mjs`. The port must be free before the daemon launches. WebSocket `initialize` must report Windows and the configured Codex home. With the probe still connected, `process-info.ps1` verifies the spawned PID, executable, owner SID, and the loopback listener or the established connection whose reverse tuple belongs to the supervisor. This also covers Windows returning an undefined TCP listener state.

`state/managed.json` tracks backend readiness. `state/desktop-managed.json` records the Desktop instance launched by its own task. A live check verifies the recorded PID, creation time, executable and owner before using a saved identity to stop a process.

The backend task requests three Task Scheduler retries one minute apart. The supervisor retries an exited daemon up to three times, with a minute of healthy uptime resetting the count. If the supervisor fails, the wrapper verifies ownership before cleaning up an orphaned daemon and retries after 5, 15 and 30 seconds. Ending the launcher requests a clean supervisor stop and allows up to 20 seconds for it to exit. The stop marker applies to the current run. A fresh start clears a stale marker. Startup, relay and shutdown diagnostics are in `state/events.jsonl`, `state/managed.json`, and `state/stopped.json`.
