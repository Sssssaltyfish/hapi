# Windows Desktop shared backend

`run.ps1` owns a per-user mutex and waits for `supervisor.mjs`. The supervisor
resolves the installed Desktop and Codex runtime on each start, launches a
loopback app-server, verifies it, then opens Desktop against that same backend.
The named-pipe relay reconnects Desktop tools to the managed app-server.

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
Stop/failure clears readiness before terminating children. A saved snapshot is
not a liveness check: verify PID, start time, executable and owner before acting
on it. An abrupt OS/process termination cannot run cleanup.

Startup, relay and unrecoverable daemon failures exit `1` with diagnostics in
`events.jsonl`, `managed.json` and `stopped.json`. An explicit stop exits `0`.
An exited daemon gets up to three local retries; one minute of healthy uptime
resets this consecutive-failure budget. Exhaustion fails the supervisor so the
scheduled task can recover the whole backend and resolve updated binaries.
The PowerShell wrapper retries failed supervisors after 5, 15 and 30 seconds,
resetting its retry budget after a minute of uptime. This also covers manual
and time-triggered task starts where Task Scheduler did not retry an action
returning a nonzero code in the observed Windows environment. Exhausted failures still propagate
their exit code. A stop marker cancels further retries.
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

## Login and recovery

The task uses the interactive user's logon trigger with a ten-second delay,
`StartWhenAvailable`, and three failure retries one minute apart. Its hidden
launcher and PowerShell wrapper preserve the child's exit code. Run
`configure-task.ps1` in an existing deployment to update these settings without
replacing its action. See [the launcher build](../hidden-task-launcher/README.md).

## Update an existing managed backend

Use an independent scheduled task, because stopping this backend also stops
the Desktop/agent that may be preparing the update. Stage these source files
outside the live deployment, then run the staged `update.ps1` with:

```powershell
./update.ps1 -DeploymentRoot "$env:LOCALAPPDATA\HAPI\windows-native" `
  -ExpectedSupervisorPid <pid> -ExpectedSupervisorStarted '<UTC timestamp>'
```

Read the expected identity from the current `managed.json` immediately before
scheduling. The updater validates identities, requests a clean stop, waits for
both processes and the task instance to exit, replaces only the listed scripts,
preserves private configuration and the task action, then starts the normal
task. It requires fresh process identities plus daemon, Desktop connection and
tools-pipe readiness. The receipt is `state/update-result.json`.

On failure after stopping, it restores the previous scripts and restarts the
same managed task. Successful verification removes the small temporary script
backup. A failed recovery retains it for inspection. This updater does not use
the original migration's `switch.ps1`/`rollback.ps1`, which unregister the managed
task and change the user's Desktop endpoint.

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
