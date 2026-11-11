# Windows Desktop shared backend

`run.ps1` holds an exclusive file handle in the deployment state directory
across Windows sessions and waits for `supervisor.mjs`. The supervisor resolves
the installed runtime, launches the loopback app-server, and verifies its identity.
With `launchDesktop: false`, the backend runs in a startup task under the owner's
limited S4U token. The separate interactive logon task runs `desktop.ps1`, waits
for that daemon, and opens Desktop against the shared endpoint. The named-pipe
relay connects Desktop tools when a Desktop instance is connected. Existing
installations without `launchDesktop: false` continue to open Desktop from the
interactive supervisor.

## Identity and readiness

The port must be free before launch. A successful WebSocket `initialize` must
return Windows and the configured Codex home. While that probe remains open,
`process-info.ps1` verifies the spawned PID, executable, owner SID and either
its loopback listener or the established connection with the reverse tuple
owned by the supervisor. The latter handles Windows reporting a live listener
as undefined TCP state `0`; undefined state itself is never accepted as proof.

`state/managed.json` records `starting`, `ready`, `restarting`, `stopping`,
`stopped` or `failed`. `daemonReady` means verified initialization, while
`toolsPipeReady` and `desktopBackendConnected` describe Desktop integration.
Stop or failure clears readiness before terminating supervisor children. After
an abrupt supervisor exit, the launcher checks for an orphaned daemon using the
retained supervisor process handle, parent PID, creation times, expected CLI
installation path and owner SID. A live check verifies PID, start time,
executable and owner before acting on a saved snapshot.

Startup, relay and unrecoverable daemon failures exit `1` with diagnostics in
`events.jsonl`, `managed.json` and `stopped.json`. An explicit stop exits `0`.
An exited daemon gets up to three local retries; one minute of healthy uptime
resets this consecutive-failure budget. Exhaustion fails the supervisor so the
wrapper can recover the whole backend and resolve updated binaries. The wrapper
retries after 5, 15 and then 30 seconds between attempts while the task is active.
A minute of supervisor uptime resets the backoff. A stop marker cancels further
retries. Ending the scheduled launcher requests a clean supervisor stop and
allows up to 20 seconds before the wrapper terminates it.
The stop file is a one-shot request: the running supervisor/wrapper consumes it,
and an explicit fresh `run.ps1` invocation discards any stale request. It never
means persistently disabled. The updater always clears its request on exit and
attempts recovery for every failure after requesting shutdown, including a
process disappearing while CIM is reading its owner.

The first rollout of this recovery change exposed an updater bug: it wrote the
stop request before marking shutdown as begun, then an exiting process caused
the owner query to fail. Recovery was skipped and the old request survived into
the next login. The updater now marks this transition before issuing the request,
counts only live process results (PowerShell arrays retain explicit nulls), and
avoids redundant owner queries while waiting for already-verified processes to
exit. Both failure-before-copy and failure-after-copy need to restore service.

## Startup, login and recovery

The backend startup task uses `StartWhenAvailable` and three task retries one
minute apart. The separate Desktop task uses the interactive user's logon trigger
with a ten-second delay. Both tasks use `task-launcher.ps1` to run their Windows
PowerShell entry points and track each task's lifetime. Run `configure-task.ps1`
in an existing deployment to refresh backend task settings while preserving its
action and principal.

Use `inspect.ps1 -CheckRunning` with the deployment's Node executable and port
to verify the native backend. Add `-RequireDesktop` to require the interactive
tools pipe and Desktop's connection to that backend.

## Update an existing managed backend

Use an independent scheduled task so the update can finish while the shared
backend restarts. Stage these source files outside the live deployment, then
run the staged `update.ps1`.

```powershell
./update.ps1 -DeploymentRoot "$env:LOCALAPPDATA\HAPI\windows-native" `
  -ExpectedSupervisorPid <pid> -ExpectedSupervisorStarted '<UTC timestamp>'
```

Read the expected identity from the current `managed.json` immediately before
scheduling. The updater validates identities, requests a clean stop, waits for
the supervisor's processes and the task instance to exit, replaces the scripts,
and starts the normal task. Provide both `-CandidateConfig` and
`-CandidateTaskXml` to change the private configuration and task definition as
part of that update. The headless configuration requires the daemon and
supervisor to be ready in session 0. The interactive configuration also requires
Desktop and tools connectivity. The receipt is `state/update-result.json`.

On failure after stopping, it restores the previous scripts, configuration and
task definition as applicable, then restarts the managed task. Successful
verification or recovery removes the temporary backup. If recovery fails, the
backup remains available for inspection. The original migration's `switch.ps1`
and `rollback.ps1` also change the user's Desktop endpoint.

## 2026-11-11 incident

On Windows build 26300.9818 (KB5127936 installed 2026-11-10) with Desktop 26.1103.7773.0, CIM reported the owned
127.0.0.1:17844 listener with raw state 0 although initialize and established
connections worked. Filtering solely for `Listen` rejected the correct backend.
The reason Windows supplied that state is not established. The login task's
operational event log was disabled, so there is no complete task-attempt trace.
A minimal Node TCP listener on a fresh ephemeral loopback port also reports raw
state 0. The condition is reproducible outside Codex; the observed runtime update
does not establish a Codex upgrade regression.
Other affected applications report the same build and update combination;
[DAX Studio PR 1507](https://github.com/DaxStudio/DaxStudio/pull/1507) added a
compatibility path. A [Microsoft Q&A reproducer](https://learn.microsoft.com/en-us/answers/questions/6057787/getextendedtcptable-returns-dwstate-0-for-listenin)
also reports undefined listeners and normal established rows. These reports
support a Windows TCP-table reporting regression, but are not a Microsoft
confirmation of the underlying implementation defect.

References: [Get-NetTCPConnection](https://learn.microsoft.com/powershell/module/nettcpip/get-nettcpconnection),
[Task Scheduler restart settings](https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element).
