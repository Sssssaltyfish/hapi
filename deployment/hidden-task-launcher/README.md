# Hidden scheduled-task launcher

Build on Windows using the installed .NET Framework compiler:

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /out:HiddenTaskLauncher.exe Launcher.cs
```

Deploy the executable alongside `windows-native/`, in
`hidden-task-launcher/`. The native installer uses it when present, otherwise
it registers the PowerShell action. Both actions wait for `run.ps1` and preserve
its exit code; nonzero failures reach Task Scheduler's restart policy.

`apply.ps1` is the historical retrofit for both existing native and runner tasks.
It assumes those task names and paths already exist. For an existing native
installation, `windows-native/configure-task.ps1` changes only recovery settings
and preserves its current action.
