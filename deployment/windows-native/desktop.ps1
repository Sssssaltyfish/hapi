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
        if ($managed.status -ne 'ready' -or !$managed.daemonReady -or $managed.launchDesktop -ne $false -or
            $managed.url -ne $config.websocketUrl -or $managed.daemon.ownerSid -ne $config.ownerSid) { return $false }
        $daemon = Get-CimInstance Win32_Process -Filter "ProcessId=$($managed.daemon.pid)"
        if (!$daemon -or
            $daemon.CreationDate.ToUniversalTime() -ne ([DateTimeOffset]$managed.daemon.started).UtcDateTime) { return $false }

        # A limited interactive token can see the Session 0 process and its
        # creation time while Windows withholds its executable and owner SID.
        # The supervisor has verified those fields in the private state file.
        if ($daemon.ExecutablePath -and $daemon.ExecutablePath -ne $managed.daemon.executable) { return $false }
        $owner = Invoke-CimMethod -InputObject $daemon -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($owner.Sid -and $owner.Sid -ne $config.ownerSid) { return $false }
        $null = & $config.nodeExe "$root\inspect.mjs" native $config.websocketUrl $config.codexHome $managed.daemon.pid
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

try {
    if ($env:HAPI_TASK_LAUNCHER_PID -or $env:HAPI_TASK_LAUNCHER_START_TICKS) {
        . (Join-Path (Split-Path -Parent $root) 'task-lifetime.ps1')
        $taskLauncher = Get-TaskLauncher
    }
    while (Test-LaunchRunning) {
        if (Test-DaemonReady) {
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
