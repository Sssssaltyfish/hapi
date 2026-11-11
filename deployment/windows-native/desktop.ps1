$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Desktop requires an interactive Windows session.' }
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
if ($config.launchDesktop -ne $false) { throw 'An independent Desktop requires a headless backend.' }
$taskLauncher = $null

function Test-LaunchRunning { !$taskLauncher -or (Test-TaskLauncherRunning $taskLauncher) }

function Test-DaemonReady {
    try {
        $managed = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json
        if (!$managed.daemonReady -or !$managed.daemon -or $managed.launchDesktop -ne $false) { return $false }
        $daemon = Get-CimInstance Win32_Process -Filter "ProcessId=$($managed.daemon.pid)"
        if (!$daemon -or $daemon.ExecutablePath -ne $managed.daemon.executable -or
            $daemon.CreationDate.ToUniversalTime().ToString('o') -ne $managed.daemon.started) { return $false }
        $owner = Invoke-CimMethod -InputObject $daemon -MethodName GetOwnerSid
        return $owner.Sid -eq $config.ownerSid
    } catch { return $false }
}

try {
    if ($env:HAPI_TASK_LAUNCHER_PID -or $env:HAPI_TASK_LAUNCHER_START_TICKS) {
        . (Join-Path (Split-Path -Parent $root) 'task-lifetime.ps1')
        $taskLauncher = Get-TaskLauncher
    }
    while (Test-LaunchRunning) {
        if (Test-DaemonReady) {
            $desktop = Start-Process -FilePath $config.nodeExe -ArgumentList @("`"$root\desktop.mjs`"") -WorkingDirectory $root -WindowStyle Hidden -PassThru
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
