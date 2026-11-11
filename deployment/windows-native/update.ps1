param(
    [Parameter(Mandatory)][string]$DeploymentRoot,
    [Parameter(Mandatory)][int]$ExpectedSupervisorPid,
    [Parameter(Mandatory)][string]$ExpectedSupervisorStarted,
    [string]$CandidateConfig,
    [string]$CandidateTaskXml
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $DeploymentRoot).Path
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$resultPath = "$root\state\update-result.json"
$files = @('runtime.mjs', 'supervisor.mjs', 'desktop.ps1', 'desktop.mjs', 'process-info.ps1', 'find-tools-pipe.ps1', 'resolve-runtime.ps1', 'run.ps1', 'install.ps1', 'configure-task.ps1', 'update.ps1', 'inspect.ps1', 'inspect.mjs', 'switch.ps1', 'rollback.ps1')
$backup = "$root\state\update-backup"
$copied = $false
$stopRequested = $false
$taskChanged = $false
$backupCreated = $false
$result = @{started=[DateTime]::UtcNow.ToString('o');ready=$false;rolledBack=$false}

function Save-Result { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8 }
function Matching-Process($Identity, [switch]$CheckOwner) {
    if (!$Identity) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)"
    if (!$process) { return $null }
    $creationMatches = $process.CreationDate -and
        $process.CreationDate.ToUniversalTime() -eq ([DateTimeOffset]$Identity.started).UtcDateTime
    if (!$CheckOwner) {
        # While waiting for shutdown, CIM can drop ExecutablePath before it
        # removes the process row. A reused PID means the old process is gone.
        if (!$process.CreationDate -or $creationMatches) { return $process }
        return $null
    }
    if (!$creationMatches -or $process.ExecutablePath -ne $Identity.executable) {
        throw "Process $($Identity.pid) identity changed or is unavailable."
    }
    try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid }
    catch {
        if (!(Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)")) { return $null }
        throw
    }
    if ($owner.Sid -ne $config.ownerSid) { throw "Process $($Identity.pid) owner does not match." }
    $process
}
function Owned-Identities($Managed) {
    if ($Managed.supervisor) { $Managed.supervisor }
    if ($Managed.daemon) { $Managed.daemon }
    if ($Managed.ownedDesktop) { $Managed.ownedDesktop }
    elseif ($null -eq $Managed.launchDesktop -and $Managed.desktop -and $Managed.supervisor) {
        # Older snapshots did not distinguish a child from a discovered Desktop.
        $desktop = Get-CimInstance Win32_Process -Filter "ProcessId=$($Managed.desktop.pid)"
        if ($desktop.ParentProcessId -eq $Managed.supervisor.pid) { $Managed.desktop }
    }
}
function Stop-Managed($Managed) {
    $identities = @(Owned-Identities $Managed)
    New-Item -ItemType File -Path "$root\state\stop" -Force | Out-Null
    $until = (Get-Date).AddSeconds(30)
    do {
        $live = @(foreach ($identity in $identities) {
            if (Matching-Process $identity) { $identity }
        })
        if (!$live.Count -and (Get-ScheduledTask -TaskName $config.taskName).State -ne 'Running') { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $until)
    throw 'Managed processes did not stop; no files replaced.'
}
function Start-Managed([DateTime]$StartedAfter) {
    Remove-Item -LiteralPath "$root\state\stop" -Force -ErrorAction SilentlyContinue
    $logonType = [string](Get-ScheduledTask -TaskName $config.taskName).Principal.LogonType
    Start-ScheduledTask -TaskName $config.taskName
    $until = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Seconds 1
        try { $state = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json } catch { continue }
        if (!$state.supervisor -or ([DateTimeOffset]$state.supervisor.started).UtcDateTime -lt $startedAfter) { continue }
        if (!$state.daemonReady -or !$state.daemon) { continue }
        $supervisor = Matching-Process $state.supervisor -CheckOwner
        $daemon = Matching-Process $state.daemon -CheckOwner
        if (!$supervisor -or !$daemon) { continue }
        if ($config.launchDesktop -eq $false) {
            if ($state.launchDesktop -ne $false -or $supervisor.SessionId -ne $daemon.SessionId) { continue }
            if ($logonType -eq 'S4U' -and $supervisor.SessionId -ne 0) { continue }
            if ($logonType -eq 'Interactive' -and $supervisor.SessionId -eq 0) { continue }
            return $state
        } elseif ($state.toolsPipeReady -and $state.desktopBackendConnected -and (Matching-Process $state.desktop -CheckOwner)) {
            return $state
        }
    } while ((Get-Date) -lt $until)
    throw 'New managed backend did not become ready.'
}

try {
    if ($root -eq $PSScriptRoot) { throw 'Run the update from a separate candidate directory.' }
    if ([bool]$CandidateConfig -ne [bool]$CandidateTaskXml) { throw 'Provide the candidate configuration and task XML together.' }
    if ($CandidateConfig) {
        $nextConfig = Get-Content -LiteralPath $CandidateConfig -Raw | ConvertFrom-Json
        foreach ($key in @('ownerSid','ownerTag','taskName','codexHome','websocketUrl')) {
            if ($nextConfig.$key -cne $config.$key) { throw "Candidate changed deployment identity field $key." }
        }
        $nextTaskXml = Get-Content -LiteralPath $CandidateTaskXml -Raw
    }
    foreach ($file in $files) {
        if (!(Test-Path -LiteralPath "$PSScriptRoot\$file" -PathType Leaf)) { throw "Candidate file missing: $file" }
    }
    $managed = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json
    if ($managed.supervisor.pid -ne $ExpectedSupervisorPid -or $managed.supervisor.started -ne $ExpectedSupervisorStarted) { throw 'Supervisor changed since update was prepared.' }
    if (!(Matching-Process $managed.supervisor -CheckOwner)) { throw 'Supervisor exited since update was prepared.' }
    foreach ($identity in Owned-Identities $managed) { Matching-Process $identity -CheckOwner | Out-Null }
    if (Test-Path -LiteralPath $backup) { throw 'Previous update backup requires review.' }
    New-Item -ItemType Directory -Path $backup | Out-Null
    $backupCreated = $true
    foreach ($file in $files) {
        if (Test-Path -LiteralPath "$root\$file") { Copy-Item -LiteralPath "$root\$file" -Destination "$backup\$file" }
    }
    if ($CandidateConfig) { Copy-Item -LiteralPath "$root\config.json" -Destination "$backup\config.json" }
    $previousTaskXml = Export-ScheduledTask -TaskName $config.taskName
    $previousTaskXml | Set-Content -LiteralPath "$backup\task.xml" -Encoding Unicode
    Save-Result
    # Stop-Managed may fail after the supervisor has already consumed the stop
    # request. Every subsequent failure must attempt recovery, not just copies.
    $stopRequested = $true
    Stop-Managed $managed
    # Mark before the first copy so a partial copy is also rolled back.
    $copied = $true
    foreach ($file in $files) { Copy-Item -LiteralPath "$PSScriptRoot\$file" -Destination "$root\$file" -Force }
    $startedAfter = [DateTime]::UtcNow
    $taskChanged = $true
    if ($CandidateConfig) {
        Copy-Item -LiteralPath $CandidateConfig -Destination "$root\config.json" -Force
        $config = $nextConfig
        Register-ScheduledTask -TaskName $config.taskName -Xml $nextTaskXml -Force | Out-Null
    } else { & "$root\configure-task.ps1" }
    $result.managed = Start-Managed $startedAfter
    $result.sha256 = @{}
    foreach ($file in $files) { $result.sha256[$file] = (Get-FileHash -LiteralPath "$root\$file" -Algorithm SHA256).Hash.ToLowerInvariant() }
    $result.ready = $true
} catch {
    $result.error = $_.Exception.Message
    $result.errorAt = $_.InvocationInfo.PositionMessage
    if ($stopRequested) {
        try {
            $current = if (Test-Path -LiteralPath "$root\state\managed.json") { Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json }
            Stop-Managed $current
            if ($copied) {
                foreach ($file in $files) {
                    if (Test-Path -LiteralPath "$backup\$file") { Copy-Item -LiteralPath "$backup\$file" -Destination "$root\$file" -Force }
                    else { Remove-Item -LiteralPath "$root\$file" -Force -ErrorAction SilentlyContinue }
                }
                if ($CandidateConfig) {
                    Copy-Item -LiteralPath "$backup\config.json" -Destination "$root\config.json" -Force
                    $config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
                }
            }
            $startedAfter = [DateTime]::UtcNow
            if ($taskChanged) { Register-ScheduledTask -TaskName $config.taskName -Xml $previousTaskXml -Force | Out-Null }
            $result.recovered = Start-Managed $startedAfter
            $result.rolledBack = $true
        } catch { $result.recoveryError = $_.Exception.Message; $result.recoveryErrorAt = $_.InvocationInfo.PositionMessage }
    }
} finally {
    if ($stopRequested) { Remove-Item -LiteralPath "$root\state\stop" -Force -ErrorAction SilentlyContinue }
    $result.finished = [DateTime]::UtcNow.ToString('o')
    Save-Result
    if ($backupCreated -and ($result.ready -or $result.rolledBack -or !$stopRequested)) {
        foreach ($file in $files) { Remove-Item -LiteralPath "$backup\$file" -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath "$backup\config.json","$backup\task.xml" -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backup -Force
    }
}
if (!$result.ready) { exit 1 }
exit 0
