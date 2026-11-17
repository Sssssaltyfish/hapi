param([switch]$FromSwitch)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. "$root\native-task.ps1"
. "$root\live-backend.ps1"
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$backup = Get-Content -LiteralPath "$root\state\rollback.json" -Raw | ConvertFrom-Json
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sessionId = (Get-Process -Id $PID).SessionId
if ($ownerSid -ne $config.ownerSid -or $sessionId -eq 0) { throw 'Run rollback in an interactive Windows session as the deployment owner.' }

function Read-State([string]$Name) {
    $file = Join-Path "$root\state" $Name
    try { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { }
}

function Get-OwnedDesktopProcess($Identity) {
    if (!$Identity.pid -or !$Identity.started -or !$Identity.executable -or $Identity.ownerSid -ne $ownerSid) { return }
    $processId = [int]$Identity.pid
    $candidate = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (!$candidate) { return }
    $verified = $false
    try {
        try { $null = $candidate.Handle } catch { if ($candidate.HasExited) { return }; throw }
        if ($candidate.HasExited) { return }
        $live = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
        if ($candidate.HasExited) { return }
        if (!$live.CreationDate -or $live.CreationDate.ToUniversalTime() -ne ([DateTimeOffset]$Identity.started).UtcDateTime) { return }
        $sid = (Invoke-CimMethod -InputObject $live -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
        if ($candidate.HasExited -or $sid -ne $ownerSid -or $live.SessionId -ne $sessionId -or
            $live.ExecutablePath -ne $Identity.executable -or [IO.Path]::GetFileName($live.ExecutablePath) -ne 'ChatGPT.exe') { return }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($live.ParentProcessId)"
        $module = [regex]::Escape((Join-Path $root 'desktop.mjs'))
        if (!$parent -or !$parent.CreationDate -or $parent.CreationDate -gt $live.CreationDate -or
            $parent.SessionId -ne $sessionId -or $parent.ExecutablePath -ne $config.nodeExe -or
            $parent.CommandLine -notmatch ('(?:^|\s)"' + $module + '"\s*$') -or
            (Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -ne $ownerSid) { return }
        $verified = !$candidate.HasExited
        if ($verified) { $candidate }
    } finally { if (!$verified) { $candidate.Dispose() } }
}

function Stop-Task([string]$Name) {
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
$desktop = $null
try {
    $taskFolder = Get-CodexTaskFolder
    $backendTask = Get-CodexDeploymentTask -Root $root -Name $config.taskName -OwnerSid $ownerSid -Entry 'run.ps1' -AllowLegacy -Optional
    $desktopTask = if ($config.desktopTaskName) {
        Get-CodexDeploymentTask -Root $root -Name $config.desktopTaskName -OwnerSid $ownerSid -Entry 'desktop.ps1' -Optional
    }
    $switchTask = if (!$FromSwitch) {
        Get-CodexDeploymentTask -Root $root -Name "$($config.taskName) switch" -OwnerSid $ownerSid -Entry 'switch.ps1' -Optional
    }
    $tasks = @($desktopTask, $backendTask) | Where-Object { $_ }
    $withDesktop = $config.launchDesktop -ne $false -or [bool]$config.desktopTaskName
    $userUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
    $restartDesktop = $FromSwitch -or !$backup.staged -or $userUrl -eq $config.websocketUrl -or
        (Test-Path -LiteralPath "$root\state\cutover")
    if ($desktopTask) { $desktop = Get-OwnedDesktopProcess (Read-State 'desktop-managed.json') }
    $proof = Get-CodexLiveBackend -Config $config -DeploymentRoot $root
    foreach ($task in $tasks) {
        if ($task.State -ne 'Disabled') {
            $restartDesktop = $true
            Disable-ScheduledTask -TaskName $task.TaskName -TaskPath '\' | Out-Null
        }
    }
    if (!$FromSwitch) {
        if ($switchTask) {
            Disable-ScheduledTask -TaskName $switchTask.TaskName -TaskPath '\' | Out-Null
            Stop-Task $switchTask.TaskName
            Unregister-ScheduledTask -TaskName $switchTask.TaskName -TaskPath '\' -Confirm:$false
        }
        Remove-Item -LiteralPath "$root\state\switch-request.json" -Force -ErrorAction SilentlyContinue
    }

    if ($desktopTask) { Stop-Task $desktopTask.TaskName }
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
        if ($backendTask) { Stop-Task $backendTask.TaskName }
        if ($proof.ok -and ((Test-CodexProcessGeneration $proof.daemon) -or (Test-CodexProcessGeneration $proof.supervisor))) {
            throw 'The verified backend did not stop.'
        }
        if ($desktop -and !$desktop.HasExited) {
            try { $null = $desktop.CloseMainWindow() } catch { if (!$desktop.HasExited) { throw } }
            if (!$desktop.WaitForExit(10000)) {
                try { $desktop.Kill() } catch { if (!$desktop.HasExited) { throw } }
            }
            if (!$desktop.WaitForExit(5000)) { throw 'The verified managed Desktop did not stop.' }
        }
        foreach ($task in $tasks) {
            Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath '\' -Confirm:$false
        }
    } finally { if ($supervisorLock) { $supervisorLock.Dispose() } }

    $userUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
    if ($userUrl -eq $config.websocketUrl) {
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',$backup.previousWsUrl,'User')
        $userUrl = $backup.previousWsUrl
    }
    $desktopStarted = $false
    $desktopAlreadyRunning = $false
    if ($withDesktop -and $restartDesktop) {
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
} finally {
    if ($desktop) { $desktop.Dispose() }
    if ($migrationLock) { $migrationLock.Dispose() }
}
