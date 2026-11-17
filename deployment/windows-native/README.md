# Windows Desktop shared backend

The shared Codex app-server runs as the deployment owner's limited interactive logon task. Desktop and HAPI connect to its loopback WebSocket independently. The optional Desktop logon task waits for the daemon before opening the app. A named pipe connects Desktop tools while the app is connected.

Both tasks run through Windows' system `wscript.exe`, `task-bootstrap.js`, `task-launcher.ps1` and `task-lifetime.ps1`. The launcher starts the PowerShell entry point without a console and tracks its lifetime. Ending the backend task requests a clean supervisor shutdown. Ending the Desktop task stops its launcher and leaves the interactive app available.

## Install and switch

Use an independent Windows PowerShell window in the deployment owner's interactive session. Prepare a Codex CLI, a Codex home and a Node executable with a global `WebSocket`. Install the Desktop package if you want its GUI and tools. Copy `windows-native` and the three shared launcher files into a private runtime directory, with the shared files beside `windows-native`.

Run these commands in the deployed `windows-native` directory. `17844` is the default loopback port. If you choose another port or Codex home, pass the same values to `inspect.ps1` and `install.ps1`. The installer accepts `-McpNodeExe` and `-BrowserNodeExe` for separate Node executables. It discovers Desktop and the CLI from the existing installation.

```powershell
$node = (Get-Command node.exe -CommandType Application).Source
& .\inspect.ps1 -NodeExe $node
& .\install.ps1 -NodeExe $node
```

For a backend without automatic GUI startup, use `install.ps1 -NodeExe $node -NoDesktopTask`. You can pin a standalone CLI with `-CliExe`. New task names are `Codex App Server <SID>` and `Codex Desktop <SID>`; existing installations retain the task names in their private configuration. The installer stages the selected tasks disabled and saves the previous user endpoint. Finish active work and exit the original Desktop before switching.

```powershell
& .\switch.ps1
& .\inspect.ps1 -NodeExe $node -CheckRunning -RequireDesktop
```

The switch enables and starts the backend and waits for its verified loopback app-server. When the Desktop task is selected, it opens the GUI and verifies a new Desktop connection in the current user session. It then sets the user environment variable `CODEX_APP_SERVER_WS_URL`. Tools and relay availability are separate diagnostic results. The switch writes `state/switch-result.json` and rolls back a failed cutover.

To have Windows close the original processes as part of a scheduled switch, run `inspect.ps1 -NodeExe $node` and identify the original `ChatGPT.exe` and its `codex.exe` app-server from their executable paths and parent PIDs. Supply each PID and its UTC creation timestamp. The task runs after 30 seconds. The following identities are fictional.

```powershell
& .\schedule-switch.ps1 -OldDesktopPid 4120 -OldDesktopStarted '2030-01-15T09:30:00.0000000Z' `
  -OldBackendPid 4188 -OldBackendStarted '2030-01-15T09:30:03.0000000Z'
```

`inspect.ps1 -LiveOnly` checks the endpoint actually serving the configured port. Add `-RequireDesktop` if both the GUI and desktop tools are required. The optional Desktop launch uses explicit process environment settings. A regular Store launch reads the user endpoint written by the switch. A stale value or `CODEX_APP_SERVER_FORCE_CLI=1` can change its routing.

Keep `config.json` and `state/` local. New installations inherit available proxy variables at launch. Use `-CaptureProxyEnvironment` to keep an explicit snapshot. Existing `proxyEnvironment` entries still apply, including an explicit empty object. The private `daemonConfigOverrides` array sets the individual CLI `-c key=value` arguments. Omitting it keeps the deployment's three compatibility overrides for code mode, MXC and Desktop tools; an empty array lets Codex use its own configuration. Changes take effect on the next daemon launch. Changing the shared address also requires updating the Desktop user endpoint and each consumer.

## Update an existing managed backend

Run the staged `update.ps1` from a separate process that can stay alive while the native backend restarts. Copy the candidate scripts to a different directory from the live deployment. For an example runtime under the local application data directory, run the following from the candidate directory with the current supervisor identity.

```powershell
$nativeRoot = Join-Path $env:LOCALAPPDATA 'HAPI\windows-native'
$report = .\inspect.ps1 -LiveOnly -DeploymentRoot $nativeRoot | ConvertFrom-Json
if (!$report.native.ok) { throw $report.native.code }
$supervisor = $report.native.supervisor
& .\update.ps1 -DeploymentRoot $nativeRoot `
  -ExpectedSupervisorPid $supervisor.pid -ExpectedSupervisorStarted $supervisor.started
```

The updater validates the supervisor identity, requests a clean stop, waits for the backend and task to exit, replaces the scripts, and starts the backend task. Provide both `-CandidateConfig` and `-CandidateTaskXml` when updating the private config and task definition together. Otherwise it refreshes the backend task's retry settings through `configure-task.ps1`. It verifies that the daemon and supervisor share the expected interactive session. The result is in `state/update-result.json`.

For an already stopped task, use `.\update.ps1 -DeploymentRoot $nativeRoot -Stopped`. The updater verifies the task, checks for active processes and checks that the configured port is free before changing files. A disabled task is returned to disabled after verification. Failed updates restore the previous files and task definition; an originally stopped deployment remains stopped. If recovery fails, the updater keeps `state/update-backup` for inspection.

## Roll back the initial switch

Run `rollback.ps1` in the deployed `windows-native` directory from an independent Windows PowerShell window under the deployment owner. Rollback disables the managed tasks, stops verified managed processes, removes the task registrations, and restores the saved user endpoint if the managed value is still in use. It reopens Codex Desktop after an active cutover if no Desktop instance is already open. Successful rollback removes the native config and saved endpoint receipt. The Codex home and diagnostic logs remain available.

## Identity and recovery

`run.ps1` takes an exclusive file lock across Windows sessions and waits for `supervisor.mjs`. The port must be free before the daemon launches. WebSocket `initialize` must report Windows and the configured Codex home. With the probe still connected, `process-info.ps1` verifies the spawned PID, executable, owner SID, and the loopback listener or the established connection whose reverse tuple belongs to the supervisor. This also covers Windows returning an undefined TCP listener state.

`state/managed.json` records the supervisor's last observation. Missing or stale records are reported separately from live health. The read-only inspector associates a real initialize response with the peer's TCP endpoint, process generation, Windows owner and parent supervisor. Desktop attachment and the tools pipe are checked independently against the running package, including a previous Store version still open after an update. `state/desktop-managed.json` records the GUI originally launched by its task for verified rollback.

The backend task requests three Task Scheduler retries one minute apart. The supervisor retries an exited daemon up to three times, with a minute of healthy uptime resetting the count. If the supervisor fails, the wrapper verifies ownership before cleaning up an orphaned daemon and retries after 5, 15 and 30 seconds. Ending the launcher requests a clean supervisor stop and allows up to 20 seconds for it to exit. The stop marker applies to the current run. A fresh start clears a stale marker. Startup, relay and shutdown diagnostics are in `state/events.jsonl`, `state/managed.json`, and `state/stopped.json`.
