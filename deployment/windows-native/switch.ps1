param(
    [int]$OldDesktopPid,
    [string]$OldDesktopStarted,
    [int]$OldBackendPid,
    [string]$OldBackendStarted
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. "$root\native-task.ps1"
. "$root\live-backend.ps1"
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$backup = Get-Content -LiteralPath "$root\state\rollback.json" -Raw | ConvertFrom-Json
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sessionId = (Get-Process -Id $PID).SessionId
if ($ownerSid -ne $config.ownerSid -or $sessionId -eq 0) { throw 'Run the switch in an interactive Windows session as the deployment owner.' }

$requestPath = "$root\state\switch-request.json"
$switchTaskName = "$($config.taskName) switch"
$scheduled = [bool]($env:HAPI_TASK_LAUNCHER_PID -or $env:HAPI_TASK_LAUNCHER_START_TICKS)
$launcher = $null
$desktop = $null
$backend = $null
$cutoverStarted = $false
$scheduledTaskVerified = $false
$withDesktop = $config.launchDesktop -ne $false -or [bool]$config.desktopTaskName
$result = @{started=[DateTime]::UtcNow.ToString('o');ready=$false;stage='preflight'}

function Get-OldProcess([int]$ProcessId, [string]$Started, [string]$Name) {
    $expectedStart = ([DateTimeOffset]$Started).UtcDateTime
    $candidate = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (!$candidate) { return }
    $verified = $false
    try {
        # Pin the process generation before verifying and keep that handle for shutdown.
        try { $null = $candidate.Handle } catch { if ($candidate.HasExited) { return }; throw }
        if ($candidate.HasExited) { return }
        $live = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if (!$live -and $candidate.HasExited) { return }
        $sid = (Invoke-CimMethod -InputObject $live -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
        if ($candidate.HasExited) { return }
        if ($live.SessionId -ne $sessionId -or $sid -ne $ownerSid -or $live.CreationDate.ToUniversalTime() -ne $expectedStart -or
            [IO.Path]::GetFileName($live.ExecutablePath) -ne $Name) { throw "Original $Name identity changed." }
        if (($Name -eq 'ChatGPT.exe' -and ($live.ExecutablePath -ne $runtime.desktopExe -or
                $live.CommandLine -match '--type=|--user-data-dir|--profile-directory')) -or
            ($Name -eq 'codex.exe' -and ($live.CommandLine -notmatch '(?:^|\s)app-server(?:\s|$)' -or
                !(Test-CodexBackendExecutable $live.ExecutablePath @{desktopExe=$runtime.desktopExe}) -or
                !(Test-OriginalBackendParent $live)))) {
            throw "Original $Name does not match the installed Desktop or its app-server."
        }
        $verified = $true
        $candidate
    } finally { if (!$verified) { $candidate.Dispose() } }
}

function Test-OriginalBackendParent($Process) {
    # The original app-server must descend from the pinned Desktop generation.
    if (!$desktop -or $desktop.HasExited) { return $false }
    while ($Process.ParentProcessId -gt 0) {
        $parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ParentProcessId)"
        if (!$parentProcess -or !$parentProcess.CreationDate -or $parentProcess.CreationDate -gt $Process.CreationDate -or
            $parentProcess.SessionId -ne $sessionId -or
            (Invoke-CimMethod -InputObject $parentProcess -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -ne $ownerSid) { return $false }
        if ($parentProcess.ProcessId -eq $desktop.Id) { return !$desktop.HasExited }
        $Process = $parentProcess
    }
    return $false
}

function Test-SwitchRunning {
    if ($launcher -and !(Test-TaskLauncherRunning $launcher)) { throw 'Scheduled switch was stopped.' }
}

function Wait-Managed([DateTime]$After) {
    $until = (Get-Date).AddSeconds(60)
    $proof = $null
    do {
        Test-SwitchRunning
        $proof = Get-CodexLiveBackend -Config $config -DeploymentRoot $root -StartedAfter $After
        if ($proof.ok -and $proof.supervisor.sessionId -eq $sessionId -and $proof.daemon.sessionId -eq $sessionId -and
            $taskFolder.GetTask($config.taskName).GetInstances(0).Count) { return $proof }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $until)
    throw "Backend readiness timed out at stage $($result.stage) ($($proof.code))."
}

function Wait-Desktop([DateTime]$After) {
    $until = (Get-Date).AddSeconds(60)
    $port = ([uri]$config.websocketUrl).Port
    do {
        Test-SwitchRunning
        $raw = & "$root\find-tools-pipe.ps1" -ExpectedDesktopExe $runtime.desktopExe -OwnerSid $ownerSid `
            -BackendPort $port -BackendPid $result.managed.daemon.pid
        if ($raw) {
            $pipe = $raw | ConvertFrom-Json
            $identity = $pipe.desktop
            if ($pipe.backendConnected -and $identity.pid -and $identity.started -and
                ([DateTimeOffset]$identity.started).UtcDateTime -ge $After) {
                # A normal Store activation can win the single-instance launch.
                # Readiness needs a verified connected client in this session.
                # Rollback separately checks ownership before stopping any GUI.
                $live = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$identity.pid)"
                if ($live.SessionId -eq $sessionId -and $live.CreationDate -and
                    $live.CreationDate.ToUniversalTime() -eq ([DateTimeOffset]$identity.started).UtcDateTime) { return $pipe }
            }
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $until)
    throw 'No new Desktop in this session connected to the verified backend.'
}

$migrationLock = [IO.File]::Open("$root\state\switch.lock", 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if ($scheduled) {
        . (Join-Path (Split-Path -Parent $root) 'task-lifetime.ps1')
        $launcher = Get-TaskLauncher
        Test-SwitchRunning
        $null = Get-CodexDeploymentTask -Root $root -Name $switchTaskName -OwnerSid $ownerSid -Entry 'switch.ps1'
        $scheduledTaskVerified = $true
        $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
        $OldDesktopPid = $request.oldDesktopPid
        $OldDesktopStarted = $request.oldDesktopStarted
        $OldBackendPid = $request.oldBackendPid
        $OldBackendStarted = $request.oldBackendStarted
    } elseif (Test-Path -LiteralPath $requestPath) { throw 'A switch is already scheduled.' }
    if ($OldDesktopPid -or $OldDesktopStarted -or $OldBackendPid -or $OldBackendStarted) {
        if (!$withDesktop) { throw 'Process identities are only used for a Desktop cutover.' }
        if ($OldDesktopPid -le 0 -or !$OldDesktopStarted -or $OldBackendPid -le 0 -or !$OldBackendStarted) {
            throw 'Supply both original PIDs and creation timestamps together.'
        }
    }
    $tasks = @(Get-CodexDeploymentTask -Root $root -Name $config.taskName -OwnerSid $ownerSid -Entry 'run.ps1' -AllowLegacy:(!$backup.staged))
    if ($config.desktopTaskName) {
        $tasks += Get-CodexDeploymentTask -Root $root -Name $config.desktopTaskName -OwnerSid $ownerSid -Entry 'desktop.ps1'
    }
    $taskFolder = Get-CodexTaskFolder
    foreach ($task in $tasks) {
        $registered = $taskFolder.GetTask($task.TaskName)
        if ($registered.GetInstances(0).Count -or ($backup.staged -and $registered.Enabled)) {
            throw "The task is already active or enabled: $($task.TaskName)."
        }
    }
    $userUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
    if ($userUrl -ne $backup.previousWsUrl -and $userUrl -ne $config.websocketUrl) { throw 'The user endpoint changed since installation.' }
    $runtime = & "$root\resolve-runtime.ps1" -Config "$root\config.json" -RequireDesktop:$withDesktop | ConvertFrom-Json
    if ($OldDesktopPid) {
        $desktop = Get-OldProcess $OldDesktopPid $OldDesktopStarted 'ChatGPT.exe'
        $backend = Get-OldProcess $OldBackendPid $OldBackendStarted 'codex.exe'
    }
    if ($withDesktop) {
        foreach ($app in Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' AND SessionId=$sessionId") {
            if ($app.ExecutablePath -eq $runtime.desktopExe -and $app.CommandLine -notmatch '--type=|--user-data-dir|--profile-directory' -and
                (Invoke-CimMethod -InputObject $app -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -eq $ownerSid -and
                $app.ProcessId -ne $OldDesktopPid) { throw 'Close the running Codex Desktop or supply its current process identity.' }
        }
    }

    Test-SwitchRunning
    New-Item -ItemType File -Path "$root\state\cutover" -Force | Out-Null
    $cutoverStarted = $true
    $result.stage = 'stop-original'
    if ($desktop -and !$desktop.HasExited) {
        try { $null = $desktop.CloseMainWindow() } catch { if (!$desktop.HasExited) { throw } }
        if (!$desktop.WaitForExit(10000)) {
            try { $desktop.Kill() } catch { if (!$desktop.HasExited) { throw } }
        }
        if (!$desktop.WaitForExit(5000)) { throw 'Original Desktop did not exit.' }
    }
    if ($backend -and !$backend.HasExited) {
        try { $backend.Kill() } catch { if (!$backend.HasExited) { throw } }
        if (!$backend.WaitForExit(5000)) { throw 'Original backend did not exit.' }
    }
    Test-SwitchRunning
    Remove-Item -LiteralPath "$root\state\managed.json","$root\state\desktop-managed.json","$root\state\stopped.json","$root\state\stop" -Force -ErrorAction SilentlyContinue
    $result.stage = 'start-backend'
    $after = [DateTime]::UtcNow
    Enable-ScheduledTask -TaskName $config.taskName -TaskPath '\' | Out-Null
    Start-ScheduledTask -TaskName $config.taskName -TaskPath '\'
    $result.managed = Wait-Managed $after
    if ($withDesktop) {
        $result.stage = 'start-desktop'
        if ($config.desktopTaskName) {
            Enable-ScheduledTask -TaskName $config.desktopTaskName -TaskPath '\' | Out-Null
            Start-ScheduledTask -TaskName $config.desktopTaskName -TaskPath '\'
        }
        $result.desktop = Wait-Desktop $after
        $verifiedBackend = Get-CodexLiveBackend -Config $config -DeploymentRoot $root -StartedAfter $after
        if (!$verifiedBackend.ok -or $verifiedBackend.daemon.pid -ne $result.managed.daemon.pid -or
            $verifiedBackend.daemon.started -ne $result.managed.daemon.started) { throw 'The backend changed during Desktop startup.' }
    }
    Test-SwitchRunning
    if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User') -ne $userUrl) { throw 'The user endpoint changed during the switch.' }
    [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',$config.websocketUrl,'User')
    $result.stage = 'complete'
    $result.ready = $true
} catch {
    $result.error = $_.Exception.Message
    if ($cutoverStarted) {
        try { & "$root\rollback.ps1" -FromSwitch | Out-Null; $result.automaticRollback = $true }
        catch { $result.automaticRollback = $false; $result.rollbackError = $_.Exception.Message }
    }
} finally {
    if ($desktop) { $desktop.Dispose() }
    if ($backend) { $backend.Dispose() }
    if ($launcher.Process) { $launcher.Process.Dispose() }
    $result.finished = [DateTime]::UtcNow.ToString('o')
    try { $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$root\state\switch-result.json" -Encoding UTF8 }
    finally {
        if ($scheduledTaskVerified) {
            Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $switchTaskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
        }
        $migrationLock.Dispose()
    }
}
if (!$result.ready) { throw "$($result.error) See state\switch-result.json." }
$result | ConvertTo-Json -Depth 6
