# Scheduled-task launcher

Deploy `task-launcher.ps1` and `task-lifetime.ps1` at the runtime root beside the
Windows runner and WSL startup scripts. Scheduled tasks run the launcher with
Windows PowerShell. The launcher starts the entry script in its configured
working directory, waits for it to exit, and returns its exit code.

The launcher passes its own PID and process start time to PowerShell. The runner
and WSL wrappers keep a handle to that process, hold separate exclusive locks
across Windows sessions, and stop their immediate child if the launcher exits.
They log native output and retry exited children with delays capped at 30
seconds. The WSL keeper closes the input pipe used by its foreground Linux
process before stopping the Windows client. Detached HAPI agent sessions remain
independent of the runner task.

`apply.ps1` updates the actions on the original native and runner tasks. It
validates both definitions and saves both originals before changing either
action. Changes take effect the next time the tasks start. Use the startup
installer to configure boot triggers and account settings.
