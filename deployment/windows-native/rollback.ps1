param([switch]$FromSwitch)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$backup = Get-Content -LiteralPath "$root\state\rollback.json" -Raw | ConvertFrom-Json
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sessionId = (Get-Process -Id $PID).SessionId
if ($ownerSid -ne $config.ownerSid -or $sessionId -eq 0) { throw 'Run rollback in an interactive Windows session as the deployment owner.' }

function Read-State([string]$Name) {
    $file = Join-Path "$root\state" $Name
    if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
}

function Stop-OwnedProcess($Identity) {
    if (!$Identity.pid) { return }
    $processId = [int]$Identity.pid
    $candidate = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (!$candidate) { return }
    try {
        try { $null = $candidate.Handle } catch { if ($candidate.HasExited) { return }; throw }
        if ($candidate.HasExited) { return }
        $live = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
        if ($candidate.HasExited) { return }
        if (!$live.CreationDate) { throw 'Managed process creation time is unavailable.' }
        if ($live.CreationDate.ToUniversalTime() -ne ([DateTimeOffset]$Identity.started).UtcDateTime) { return }
        $sid = (Invoke-CimMethod -InputObject $live -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
        if ($candidate.HasExited) { return }
        if ($sid -ne $ownerSid -or !$Identity.executable -or $live.ExecutablePath -ne $Identity.executable) {
            throw 'Managed process ownership could not be verified.'
        }
        try { $candidate.Kill() } catch { if (!$candidate.HasExited) { throw } }
        if (!$candidate.WaitForExit(5000)) { throw 'A verified managed process did not stop.' }
    } finally { $candidate.Dispose() }
}

function Stop-Task([string]$Name) {
    if (!(Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue)) { return }
    $registered = $taskFolder.GetTask($Name)
    if ($registered.GetInstances(0).Count) {
        try { Stop-ScheduledTask -TaskName $Name -TaskPath '\' }
        catch { if ($registered.GetInstances(0).Count) { throw } }
    }
    $until = (Get-Date).AddSeconds(15)
    while ($registered.GetInstances(0).Count) {
        if ((Get-Date) -ge $until) { throw "Task did not stop: $Name." }
        Start-Sleep -Milliseconds 250
    }
}

# Automatic rollback runs while the calling switch holds this lock.
$migrationLock = $null
if (!$FromSwitch) { $migrationLock = [IO.File]::Open("$root\state\switch.lock", 'OpenOrCreate', 'ReadWrite', 'None') }
try {
    $taskService = New-Object -ComObject 'Schedule.Service'
    $taskService.Connect()
    $taskFolder = $taskService.GetFolder('\')
    $taskNames = @($config.desktopTaskName, $config.taskName) | Where-Object { $_ }
    $userUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
    $restartDesktop = $FromSwitch -or !$backup.staged -or $userUrl -eq $config.websocketUrl -or
        (Test-Path -LiteralPath "$root\state\cutover")
    foreach ($name in $taskNames) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
        if ($task -and $task.State -ne 'Disabled') {
            $restartDesktop = $true
            Disable-ScheduledTask -TaskName $name -TaskPath '\' | Out-Null
        }
    }
    if (!$FromSwitch) {
        $switchTaskName = "$($config.taskName) switch"
        if (Get-ScheduledTask -TaskName $switchTaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
            Disable-ScheduledTask -TaskName $switchTaskName -TaskPath '\' | Out-Null
            Stop-Task $switchTaskName
            Unregister-ScheduledTask -TaskName $switchTaskName -TaskPath '\' -Confirm:$false
        }
        Remove-Item -LiteralPath "$root\state\switch-request.json" -Force -ErrorAction SilentlyContinue
    }

    $managed = Read-State 'managed.json'
    if ($config.desktopTaskName) { Stop-Task $config.desktopTaskName }
    # The backend wrapper holds this file until supervisor cleanup has finished.
    $supervisorLock = $null
    try {
        $until = (Get-Date).AddSeconds(30)
        New-Item -ItemType File -Path "$root\state\stop" -Force | Out-Null
        do {
            try { $supervisorLock = [IO.File]::Open("$root\state\supervisor.lock", 'OpenOrCreate', 'ReadWrite', 'None') }
            catch [IO.IOException] {
                if (($_.Exception.HResult -band 0xffff) -notin @(32,33)) { throw }
                if ((Get-Date) -ge $until) { throw 'The backend wrapper did not finish cleanup.' }
                Start-Sleep -Milliseconds 500
            }
        } until ($supervisorLock)
        Stop-Task $config.taskName
        $latest = Read-State 'managed.json'
        $desktop = $managed.ownedDesktop
        if ($config.launchDesktop -eq $false) { $desktop = Read-State 'desktop-managed.json' }
        elseif ($null -eq $managed.launchDesktop -and $managed.desktop -and $managed.supervisor) {
            # Older snapshots also recorded discovered Desktop instances.
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$managed.desktop.pid)"
            if ($candidate.ParentProcessId -eq $managed.supervisor.pid) { $desktop = $managed.desktop }
        }
        foreach ($identity in @($desktop,$latest.ownedDesktop,$managed.supervisor,$latest.supervisor,$managed.daemon,$latest.daemon)) {
            Stop-OwnedProcess $identity
        }
        foreach ($name in $taskNames) {
            if (Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false
            }
        }
    } finally { if ($supervisorLock) { $supervisorLock.Dispose() } }

    $userUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
    if ($userUrl -eq $config.websocketUrl) {
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',$backup.previousWsUrl,'User')
        $userUrl = $backup.previousWsUrl
    }
    $desktopStarted = $false
    $desktopAlreadyRunning = $false
    if ($restartDesktop) {
        $package = $null
        try { $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 } catch { }
        $desktopExe = if ($package) { Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
        if (!$desktopExe -or !(Test-Path -LiteralPath $desktopExe -PathType Leaf)) { $desktopExe = $config.desktopExe }
        if (!$desktopExe -or !(Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw 'Installed Codex Desktop is unavailable.' }
        $desktopAlreadyRunning = [bool](Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' AND SessionId=$sessionId" | Where-Object {
            $_.ExecutablePath -eq $desktopExe -and $_.CommandLine -notmatch '--type=|--user-data-dir|--profile-directory' -and
                (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -eq $ownerSid
        })
        if (!$desktopAlreadyRunning) {
            $inheritedUrl = $env:CODEX_APP_SERVER_WS_URL
            try {
                $env:CODEX_APP_SERVER_WS_URL = $userUrl
                Start-Process -FilePath $desktopExe
                $desktopStarted = $true
            } finally { $env:CODEX_APP_SERVER_WS_URL = $inheritedUrl }
        }
    }
    Remove-Item -LiteralPath "$root\state\managed.json","$root\state\managed.json.tmp","$root\state\desktop-managed.json","$root\state\stop","$root\state\open","$root\state\stopped.json","$root\state\cutover" -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$root\config.json","$root\state\rollback.json" -Force
    @{rolledBack=$true;desktopStarted=$desktopStarted;desktopAlreadyRunning=$desktopAlreadyRunning} | ConvertTo-Json
} finally { if ($migrationLock) { $migrationLock.Dispose() } }
