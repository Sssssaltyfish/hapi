# Scheduled-task launcher

Deploy `task-bootstrap.js`, `task-launcher.ps1` and `task-lifetime.ps1` at the
runtime root beside the Windows runner and WSL startup scripts. Scheduled tasks
run Windows' signed `wscript.exe` with the JScript bootstrap. It starts PowerShell
hidden before console creation; a direct PowerShell `-WindowStyle Hidden` action
can still open Windows Terminal. Supervision stays in PowerShell. The launcher
starts the entry script in its configured directory and returns its exit code.

The launcher retains the verified script-host process handle and exits if that
host is stopped. It passes its own PID and process start time to PowerShell. The runner
and WSL wrappers keep a handle to that process, hold separate exclusive locks
across Windows sessions, and stop their immediate child if the launcher exits.
They log native output and retry exited children with delays capped at 30
seconds. The WSL keeper closes the input pipe used by its foreground Linux
process before stopping the Windows client. Detached HAPI agent sessions remain
independent of the runner task.

Use `deployment/install-background-services.ps1` to update the launcher and all
task actions together, with service readiness checks and rollback. `apply.ps1`
is a retired entry point. The old `Launcher.cs` is retained only as historical
source; deployment no longer uses a custom executable.
