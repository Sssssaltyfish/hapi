# WSL service recovery

Run `bash install-recovery.sh --codex --dsh --termix` with only the components you use, as the account owning those services. No components are selected by default. The installer does not install the underlying applications. Keep user lingering enabled so enabled user units start with the distribution; on Windows use the separately configured WSL keeper.

The watchdog checks the existing control socket through `codex app-server daemon version`, recovering it with `codex app-server daemon start` and the saved lifecycle settings. HAPI and Desktop use the same socket. Its private environment script is selected by `CODEX_DAEMON_ENV`, or an optional adjacent `service-env.sh`. Supply `CODEX_BIN` or make Codex available on PATH. Stopping the watchdog leaves the managed daemon running; use Codex CLI separately for daemon maintenance.

The DSH drop-in uses the installed `dsh-web.service` for its launch command and proxy settings. It checks that the local listener returns HTTP 200 or 401 for 30 consecutive seconds. DSH retries after 30 seconds whenever it exits or the readiness check fails.

Before selecting Termix, put `TERMIX_ROOT` in private `~/.config/seia-wsl/termix-backup.env`; optionally set `TERMIX_SHARED_AUTH_DB` if using shared authentication. Example fictional values are `/srv/example/termix` and `/srv/example/auth/passkeys.sqlite`. The backup script is installed under `~/.local/lib/seia-wsl/`, independent of the application directory. Run `systemctl --user start termix-backup.service` for a manual backup. It records the prior running state before stopping Termix and restores it through both normal and systemd cleanup. The installer preserves timer enablement.

HAPI Hub/Runner wrappers use `HAPI_SERVICE_ENV`, or optional `service-env.sh` beside the wrappers. Configure PATH, public URL, auth origin and any required provider setup there. Use separate explicit files when Hub and Runner need different settings. No proxy, NVM or provider gateway is automatically sourced. Restart the affected wrapper after changing its private environment; a running process does not reload it automatically.

Shared authentication is optional and uses the handoff's current integration patch with each application's own login page. The retired machine-specific bootstrap and its patch are available only through Git history.
