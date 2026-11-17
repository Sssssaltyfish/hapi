$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. "$root\live-backend.ps1"
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Desktop requires an interactive Windows session.' }
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
if ($config.launchDesktop -ne $false) { throw 'An independent Desktop requires a headless backend.' }
$taskLauncher = $null

function Test-LaunchRunning { !$taskLauncher -or (Test-TaskLauncherRunning $taskLauncher) }

try {
    if ($env:HAPI_TASK_LAUNCHER_PID -or $env:HAPI_TASK_LAUNCHER_START_TICKS) {
        . (Join-Path (Split-Path -Parent $root) 'task-lifetime.ps1')
        $taskLauncher = Get-TaskLauncher
    }
    while (Test-LaunchRunning) {
        $backend = Get-CodexLiveBackend -Config $config -DeploymentRoot $root
        if ($backend.ok -and (Test-LaunchRunning)) {
            $start = [Diagnostics.ProcessStartInfo]::new($config.nodeExe, "`"$root\desktop.mjs`"")
            $start.WorkingDirectory = $root
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $desktop = [Diagnostics.Process]::Start($start)
            try {
                while (!$desktop.WaitForExit(500)) {
                    if (!(Test-LaunchRunning)) {
                        # Ending the task wrapper leaves the interactive app available.
                        $desktop.Kill()
                        exit 0
                    }
                }
                exit $desktop.ExitCode
            } finally { $desktop.Dispose() }
        }
        Start-Sleep -Seconds 2
    }
} finally { if ($taskLauncher.Process) { $taskLauncher.Process.Dispose() } }
