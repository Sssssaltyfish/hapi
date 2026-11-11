$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$stateDirectory = "$root\state"
$stopFile = "$stateDirectory\stop"
$taskLauncher = $null
$lock = $null

function Test-LaunchRunning { !$taskLauncher -or (Test-TaskLauncherRunning $taskLauncher) }

function Stop-Requested {
    if (!(Test-Path -LiteralPath $stopFile)) { return $false }
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    return $true
}

function Write-Event($Event) {
    $Event.at = [DateTime]::UtcNow.ToString('o')
    $Event | ConvertTo-Json -Compress | Add-Content -LiteralPath "$stateDirectory\events.jsonl" -Encoding UTF8
}

function Stop-OrphanedDaemon([Diagnostics.Process]$Supervisor) {
    $cliDirectory = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $firstPossibleStart = $Supervisor.StartTime.ToUniversalTime().AddTicks(-9)
    $supervisorExit = $Supervisor.ExitTime.ToUniversalTime()
    # The retained supervisor handle pins its PID until this check is complete.
    foreach ($candidate in Get-CimInstance Win32_Process -Filter "ParentProcessId=$($Supervisor.Id)") {
        $executable = $candidate.ExecutablePath
        if (!$executable -or [IO.Path]::GetFileName($executable) -ne 'codex.exe' -or
            [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($executable)) -ne $cliDirectory) { continue }
        $created = $candidate.CreationDate.ToUniversalTime()
        if ($created -lt $firstPossibleStart -or $created -gt $supervisorExit) { continue }
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        if (!$process) { continue }
        try {
            $null = $process.Handle
            $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)"
            if (!$live -or $live.ParentProcessId -ne $Supervisor.Id -or $live.ExecutablePath -ne $executable -or
                $live.CreationDate.ToUniversalTime() -ne $created) { continue }
            $owner = Invoke-CimMethod -InputObject $live -MethodName GetOwnerSid
            if ($owner.Sid -ne $config.ownerSid -or $process.HasExited) { continue }
            $process.Kill()
            if (!$process.WaitForExit(5000)) { throw 'Orphaned daemon did not exit.' }
            Write-Event @{event='orphan-daemon-stopped';pid=$candidate.ProcessId;supervisorPid=$Supervisor.Id}
        } catch {
            if (!$process.HasExited) { Write-Event @{event='orphan-daemon-stop-failed';pid=$candidate.ProcessId;message=$_.Exception.Message} }
        } finally { $process.Dispose() }
    }
}

try {
    if ($env:HAPI_TASK_LAUNCHER_PID -or $env:HAPI_TASK_LAUNCHER_START_TICKS) {
        . (Join-Path (Split-Path -Parent $root) 'task-lifetime.ps1')
        $taskLauncher = Get-TaskLauncher
        if (!(Test-LaunchRunning)) { exit 0 }
    }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $lockPath = "$stateDirectory\supervisor.lock"
    if ($taskLauncher -and $config.launchDesktop -eq $false) {
        # A replacement task can arrive while the previous wrapper is still cleaning up.
        $lock = Enter-TaskInstance $taskLauncher $lockPath
    } else {
        try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if (($_.Exception.HResult -band 0xffff) -notin @(32,33)) { throw }
            if ($config.launchDesktop -ne $false) {
                New-Item -ItemType File -Path "$stateDirectory\open" -Force | Out-Null
            }
            exit 0
        }
    }
    if (!$lock -or !(Test-LaunchRunning)) { exit 0 }
    # The stop marker applies to the current run and is cleared on a fresh start.
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    $delays = @(5,15,30)
    $attempt = 0
    while (Test-LaunchRunning) {
        $started = [Diagnostics.Stopwatch]::StartNew()
        $child = $null
        $stopWait = $null
        $failure = $null
        try {
            $start = [Diagnostics.ProcessStartInfo]::new($config.nodeExe, "`"$root\supervisor.mjs`"")
            $start.WorkingDirectory = $root
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $child = [Diagnostics.Process]::Start($start)
            $null = $child.Handle
            while (!$child.WaitForExit(500)) {
                if (!$stopWait) {
                    if (!(Test-LaunchRunning)) { New-Item -ItemType File -Path $stopFile -Force | Out-Null }
                    if (Test-Path -LiteralPath $stopFile) { $stopWait = [Diagnostics.Stopwatch]::StartNew() }
                } elseif ($stopWait.Elapsed.TotalSeconds -ge 20) {
                    $child.Kill()
                    $child.WaitForExit()
                }
            }
            $code = if ($null -ne $child.ExitCode) { $child.ExitCode } else { 1 }
        } catch {
            $code = 1
            $failure = @{reason='supervisor-launch';message=$_.Exception.Message}
        } finally {
            if ($child) {
                try {
                    if (!$child.HasExited) { $child.Kill(); $child.WaitForExit() }
                    Stop-OrphanedDaemon $child
                } catch { Write-Event @{event='orphan-daemon-check-failed';message=$_.Exception.Message} }
                finally { $child.Dispose() }
            }
        }
        if ($code -ne 0) {
            # A killed supervisor cannot clear its own ready snapshot.
            try { $state = Get-Content -LiteralPath "$stateDirectory\managed.json" -Raw | ConvertFrom-Json }
            catch { $state = [pscustomobject]@{} }
            $state | Add-Member -Force -NotePropertyMembers @{status='failed';daemonReady=$false;toolsPipeReady=$false;desktopBackendConnected=$false;at=[DateTime]::UtcNow.ToString('o')}
            if ($failure -or !$state.failure) {
                if (!$failure) { $failure = @{reason='supervisor-exit';exitCode=$code} }
                $state | Add-Member -Force -NotePropertyName failure -NotePropertyValue $failure
            }
            $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$stateDirectory\managed.json" -Encoding UTF8
        }
        if ((Stop-Requested) -or $stopWait -or !(Test-LaunchRunning)) { exit 0 }
        if ($code -eq 0) { exit 0 }
        if ($started.Elapsed.TotalSeconds -ge 60) { $attempt = 0 }
        $delay = $delays[$attempt]
        $attempt = [Math]::Min($attempt + 1, $delays.Count - 1)
        Write-Event @{event='supervisor-retry';delaySeconds=$delay;exitCode=$code}
        for ($remaining = $delay; $remaining -gt 0; $remaining--) {
            Start-Sleep -Seconds 1
            if ((Stop-Requested) -or !(Test-LaunchRunning)) { exit 0 }
        }
    }
} finally {
    if ($lock) { $lock.Dispose() }
    if ($taskLauncher.Process) { $taskLauncher.Process.Dispose() }
}
