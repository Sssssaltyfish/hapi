param(
    [int]$OldDesktopPid,
    [string]$OldDesktopStarted,
    [int]$OldBackendPid,
    [string]$OldBackendStarted
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
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
        if (($Name -eq 'ChatGPT.exe' -and $live.ExecutablePath -ne $runtime.desktopExe) -or
            ($Name -eq 'codex.exe' -and $live.CommandLine -notmatch '(?:^|\s)app-server(?:\s|$)')) {
            throw "Original $Name does not match the installed Desktop or its app-server."
        }
        $verified = $true
        $candidate
    } finally { if (!$verified) { $candidate.Dispose() } }
}

function Test-SwitchRunning {
    if ($launcher -and !(Test-TaskLauncherRunning $launcher)) { throw 'Scheduled switch was stopped.' }
}

function Test-LiveIdentity($Identity) {
    if (!$Identity.pid -or !$Identity.started -or $Identity.ownerSid -ne $ownerSid) { return $false }
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Identity.pid)"
    return $live -and $live.SessionId -eq $sessionId -and $live.ExecutablePath -eq $Identity.executable -and
        $live.CreationDate.ToUniversalTime() -eq ([DateTimeOffset]$Identity.started).UtcDateTime -and
        (Invoke-CimMethod -InputObject $live -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -eq $ownerSid
}

function Wait-Managed([DateTime]$After, [switch]$RequireDesktop) {
    $until = (Get-Date).AddSeconds(60)
    do {
        Test-SwitchRunning
        Start-Sleep -Seconds 1
        try { $state = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json } catch { continue }
        if ($state.status -ne 'ready' -or !$state.daemonReady -or $state.url -ne $config.websocketUrl -or
            ($config.launchDesktop -eq $false -and $state.launchDesktop -ne $false) -or
            !$state.supervisor.started -or ([DateTimeOffset]$state.supervisor.started).UtcDateTime -lt $After -or
            !(Test-LiveIdentity $state.daemon)) { continue }
        if (!$RequireDesktop) { return $state }
        if (!$state.toolsPipeReady -or !$state.desktopBackendConnected) { continue }
        $desktopIdentity = $state.ownedDesktop
        if ($config.launchDesktop -eq $false) {
            try { $desktopIdentity = Get-Content -LiteralPath "$root\state\desktop-managed.json" -Raw | ConvertFrom-Json } catch { continue }
        }
        if ($desktopIdentity.pid -eq $state.desktop.pid -and (Test-LiveIdentity $desktopIdentity)) { return $state }
    } while ((Get-Date) -lt $until)
    throw "Readiness timed out at stage $($result.stage)."
}

$migrationLock = [IO.File]::Open("$root\state\switch.lock", 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if ($scheduled) {
        . (Join-Path (Split-Path -Parent $root) 'task-lifetime.ps1')
        $launcher = Get-TaskLauncher
        Test-SwitchRunning
        $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
        $OldDesktopPid = $request.oldDesktopPid
        $OldDesktopStarted = $request.oldDesktopStarted
        $OldBackendPid = $request.oldBackendPid
        $OldBackendStarted = $request.oldBackendStarted
    } elseif (Test-Path -LiteralPath $requestPath) { throw 'A switch is already scheduled.' }
    if ($OldDesktopPid -or $OldDesktopStarted -or $OldBackendPid -or $OldBackendStarted) {
        if ($OldDesktopPid -le 0 -or !$OldDesktopStarted -or $OldBackendPid -le 0 -or !$OldBackendStarted) {
            throw 'Supply both original PIDs and creation timestamps together.'
        }
    }
    $tasks = @($config.taskName)
    if ($config.launchDesktop -eq $false) {
        if (!$config.desktopTaskName) { throw 'The separate Desktop task is missing from configuration.' }
        $tasks += $config.desktopTaskName
    }
    foreach ($name in $tasks) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath '\'
        if ($task.State -eq 'Running' -or ($backup.staged -and $task.State -ne 'Disabled')) {
            throw "The task is already active or enabled: $name."
        }
        if ($backup.staged) {
            $script = if ($name -eq $config.taskName) { 'run.ps1' } else { 'desktop.ps1' }
            $bootstrap = Join-Path (Split-Path -Parent $root) 'task-bootstrap.js'
            $expected = "//B //NoLogo `"$bootstrap`" `"$root\$script`" `"$root`""
            if ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -ne $expected -or
                $task.Actions[0].Execute -ne (Join-Path ([Environment]::SystemDirectory) 'wscript.exe') -or
                $task.Principal.LogonType -ne 'Interactive' -or $task.Principal.RunLevel -ne 'Limited') {
                throw "Unexpected staged task definition: $name."
            }
        }
    }
    $userUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
    if ($userUrl -ne $backup.previousWsUrl -and $userUrl -ne $config.websocketUrl) { throw 'The user endpoint changed since installation.' }
    $runtime = & "$root\resolve-runtime.ps1" -Config "$root\config.json" | ConvertFrom-Json
    if ($OldDesktopPid) {
        $desktop = Get-OldProcess $OldDesktopPid $OldDesktopStarted 'ChatGPT.exe'
        $backend = Get-OldProcess $OldBackendPid $OldBackendStarted 'codex.exe'
    }
    foreach ($app in Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' AND SessionId=$sessionId") {
        if ($app.ExecutablePath -eq $runtime.desktopExe -and $app.CommandLine -notmatch '--type=|--user-data-dir|--profile-directory' -and
            (Invoke-CimMethod -InputObject $app -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -eq $ownerSid -and
            $app.ProcessId -ne $OldDesktopPid) { throw 'Close the running Codex Desktop or supply its current process identity.' }
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
    $null = Wait-Managed $after
    $result.stage = 'start-desktop'
    if ($config.launchDesktop -eq $false) {
        Enable-ScheduledTask -TaskName $config.desktopTaskName -TaskPath '\' | Out-Null
        Start-ScheduledTask -TaskName $config.desktopTaskName -TaskPath '\'
    }
    $result.managed = Wait-Managed $after -RequireDesktop
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
        if ($scheduled) {
            Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $switchTaskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
        }
        $migrationLock.Dispose()
    }
}
if (!$result.ready) { throw "$($result.error) See state\switch-result.json." }
$result | ConvertTo-Json -Depth 6
