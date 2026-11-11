# WSL service recovery

Run `bash install-recovery.sh` from this directory as the account that owns the WSL services. The installer enables the Codex watchdog and loads the DSH recovery settings without restarting DSH. Keep user lingering enabled so the WSL user services start with the distribution.

The watchdog checks the existing Codex control socket through `codex app-server daemon version`. If the daemon is unavailable, `codex app-server daemon start` recovers it using Codex’s saved settings and lifecycle lock. HAPI and the desktop SSH proxy use the same control socket. Stopping the watchdog leaves the managed Codex process running. Use the Codex CLI to stop that process separately for maintenance.

The DSH drop-in uses the installed `dsh-web.service` for its launch command and proxy settings. It checks that the local listener returns HTTP 200 or 401 for 30 consecutive seconds. DSH retries after 30 seconds whenever it exits or the readiness check fails.

Run `systemctl --user start termix-backup.service` to request a backup outside the daily schedule. Termix persists its in-memory database when stopped. The backup records whether Termix was running before requesting shutdown. The backup script and the unit’s stop hook use that record to queue a restart after a completed or interrupted backup. The record lives in the user runtime directory. At the next WSL boot, the enabled `termix.service` starts normally. The installer preserves the backup timer’s existing enabled state.

`auth-bootstrap.patch` applies to the separate `seia-auth` repository at `415fc67b9a6bf0e7e13fe4bcc46b99c0659c914c`. Its `deploy.py` requires `--bootstrap` and checks that the shared authentication environment, unit, and routes are absent before writing any files. An existing installation continues to use its deployed service and private configuration.
