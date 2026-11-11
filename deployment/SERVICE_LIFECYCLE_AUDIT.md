# Service lifecycle audit — 2026-11-11

The audit follows startup, early failures, stop, cutover and rollback in the scripts. Runtime checks establish the actual process ownership and Windows account context; they do not replace that review.

## Ownership and startup

- Windows Tailscale owns the private HTTPS/TCP entry points. Enable its active profile's unattended mode with `tailscale set --unattended=true`.
- The WSL distribution belongs to the Windows user. Its keeper, Windows runner and Native backend use limited Interactive logon tasks. Windows ARSO restores the last signed-in user after normal restart or shutdown/cold boot, and Winlogon locks that session. This requires remaining signed in until shutdown; unexpected power loss is not a guaranteed path.
- The keeper is a long-lived Windows WSL client. Linux systemd owns whichever application units are installed. User lingering starts enabled units when the distribution starts.
- The WSL Codex watchdog uses the official managed daemon's `version` and `start` commands. `start` reuses an existing daemon; `bootstrap` would stop it. HAPI and Desktop SSH connect to the same canonical control socket.
- The Windows Codex backend and Desktop have distinct lifetimes but share the interactive session. A Session 0 backend could initialize, but its MXC PowerShell workers failed with 0xC0000142; daemon readiness alone did not imply usable agent execution. The backend remains available when Desktop closes.
- Permanent Autologon is not required. The migration helper can explicitly remove its saved password without retrieving it. The recipient chooses ARSO policy according to the target machine; the helper does not change disk encryption.

## Findings and disposition

| Path | Control-flow defect | Resolution |
| --- | --- | --- |
| Windows service tasks | WSL linger did not start the distribution; Windows sandbox workloads failed in Session 0 | ARSO and owner Interactive logon tasks; separate Desktop task |
| Windows runner wrapper | Dependency lookup outside retry; redirected native stderr could terminate PowerShell; detached version handoff defeated process ownership | Retry dependency discovery and launches, preserve native exit codes, disable manager version handoff |
| Hidden launcher and wrappers | Stopping the task could leave its PowerShell loop restarting workers | Watch the exact launcher process handle; exclusive file lock across sessions; stop the immediate owned worker |
| Direct PowerShell task action | WindowStyle Hidden still created Terminal windows before the script ran | Microsoft-signed wscript.exe starts a small JScript bootstrap hidden; PowerShell owns supervision and all child console launches use CreateNoWindow |
| Native updater | During shutdown CIM lost an exiting process's executable path | Strict identity proof before stop; wait for the verified process generation to disappear without rechecking unavailable exit metadata |
| WSL keeper | No singleton, logs or explicit Linux working directory | Shared lifetime helper, bounded retry delay, `--cd /` |
| WSL Codex | No durable service ensured the official daemon was available | Enabled user watchdog; reuse the current managed daemon |
| DSH Web | Three failed starts permanently exhausted its retry budget | Disable permanent start limit, retain 30-second retry spacing and readiness checks |
| Termix backup | Stop happened before the cleanup boundary; abrupt termination could leave the service stopped | Preserve prior active state and restore through systemd cleanup as well as normal cleanup |
| Auth bootstrap | Machine-specific topology and old shared-login redirects could overwrite an existing installation | Retired from current deployment and distribution; use the current shared-auth integration patch |
| Old Windows directory migration | One-time layout assumptions, process snapshot races and stale TCP listener checks | Retired entry point; original code remains in commit 42887417; use current installers/updater |

Editor removes its old Unix socket before binding. Other live user units have retry intervals that cannot exhaust their default five-start/ten-second limits. The HAPI artifact builder stages in a new temporary directory and publishes only complete output. The handoff publisher locks concurrent publication and removes temporary staging on normal errors. No functional changes were needed for those paths.

## Separate outbound proxy dependency

Tailscale forwarding and agent model requests are separate network paths. A desktop proxy may become available only after its GUI starts, so task readiness and Web reachability do not prove model reachability. Provider credentials and optional proxies belong in target-machine configuration.

Current wrappers do not force a proxy client, port, Node manager or provider wrapper. The portable handoff gives direct-network, existing-proxy and independent-core options. Windows Tailscale retains its official service.

## Evidence and limits

Historical focused checks cover exact child lifetime, daemon adoption, deployed readiness and hidden launch/exit propagation in an interactive session. PowerShell and Git worked in the default Codex execution environment after returning from Session 0. Desktop tools and backend connectivity were checked independently. A whole-machine reboot has not been performed; target-machine ARSO recovery remains a separate acceptance check. Configuration portability checks do not claim a fresh installation on another PC has been exercised.

Primary references:

- [Windows task logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)
- [ARSO requirements and credential lifecycle](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/winlogon-automatic-restart-sign-on--arso-)
- [LSA private-data deletion](https://learn.microsoft.com/en-us/windows/win32/api/ntsecapi/nf-ntsecapi-lsastoreprivatedata)
- [PowerShell/Terminal hidden-window issue](https://github.com/microsoft/terminal/issues/12464)
- [MXC Session 0 workload failure](https://github.com/microsoft/mxc/issues/1465)
- [Windows boot triggers](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger)
- [WSL systemd lifecycle](https://learn.microsoft.com/en-us/windows/wsl/systemd)
- [Tailscale unattended mode](https://tailscale.com/docs/how-to/run-unattended)
- [Installed Codex daemon lifecycle](https://github.com/openai/codex/blob/rust-v0.165.0-alpha.1.2/codex-rs/app-server-daemon/src/lib.rs)
- [FlClash external-core limitation](https://github.com/chen08209/FlClash/issues/2394)
- [FlClash core ownership](https://github.com/chen08209/FlClash/blob/v0.9.3/lib/core/desktop/lifecycle.dart)
