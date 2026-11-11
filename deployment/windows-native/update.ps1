param(
    [Parameter(Mandatory)][string]$DeploymentRoot,
    [Parameter(Mandatory)][int]$ExpectedSupervisorPid,
    [Parameter(Mandatory)][string]$ExpectedSupervisorStarted
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $DeploymentRoot).Path
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$resultPath = "$root\state\update-result.json"
$files = @('supervisor.mjs', 'process-info.ps1', 'run.ps1', 'install.ps1', 'configure-task.ps1', 'update.ps1', 'inspect.ps1', 'inspect.mjs')
$backup = "$root\state\update-backup"
$copied = $false
$stopRequested = $false
$result = @{started=[DateTime]::UtcNow.ToString('o');ready=$false;rolledBack=$false}

function Save-Result { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8 }
function Matching-Process($Identity, [switch]$CheckOwner) {
    if (!$Identity) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)"
    if (!$process) { return $null }
    if ($process.CreationDate.ToUniversalTime().ToString('o') -ne $Identity.started -or $process.ExecutablePath -ne $Identity.executable) {
        throw 'Process identity changed; refusing to stop it.'
    }
    # Verify ownership before requesting shutdown and after starting. During
    # shutdown, PID + creation time + executable already identify that same
    # verified process, so avoid a second CIM call racing with process exit.
    if ($CheckOwner) {
        try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid }
        catch {
            if (!(Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)")) { return $null }
            throw
        }
        if ($owner.Sid -ne $config.ownerSid) { throw 'Process owner changed; refusing to stop it.' }
    }
    $process
}
function Stop-Managed($Managed) {
    New-Item -ItemType File -Path "$root\state\stop" -Force | Out-Null
    $until = (Get-Date).AddSeconds(30)
    do {
        $live = @(foreach ($identity in @($Managed.supervisor, $Managed.daemon, $Managed.desktop)) {
            if (Matching-Process $identity) { $identity }
        })
        if (!$live.Count -and (Get-ScheduledTask -TaskName $config.taskName).State -ne 'Running') { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $until)
    throw 'Managed processes did not stop; no files replaced.'
}
function Start-Managed {
    Remove-Item -LiteralPath "$root\state\stop" -Force -ErrorAction SilentlyContinue
    $startedAfter = [DateTime]::UtcNow
    Start-ScheduledTask -TaskName $config.taskName
    $until = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Seconds 1
        try { $state = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json } catch { continue }
        if (!$state.supervisor -or ([DateTimeOffset]$state.supervisor.started).UtcDateTime -lt $startedAfter) { continue }
        if ($state.daemonReady -and $state.toolsPipeReady -and $state.desktopBackendConnected) {
            foreach ($identity in @($state.supervisor,$state.daemon,$state.desktop)) {
                if (!(Matching-Process $identity -CheckOwner)) { throw 'Ready state refers to an exited process.' }
            }
            return $state
        }
    } while ((Get-Date) -lt $until)
    throw 'New managed backend did not become ready.'
}

try {
    if ($root -eq $PSScriptRoot) { throw 'Run the update from a separate candidate directory.' }
    foreach ($file in $files) {
        if (!(Test-Path -LiteralPath "$PSScriptRoot\$file" -PathType Leaf)) { throw "Candidate file missing: $file" }
    }
    $managed = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json
    if ($managed.supervisor.pid -ne $ExpectedSupervisorPid -or $managed.supervisor.started -ne $ExpectedSupervisorStarted) { throw 'Supervisor changed since update was prepared.' }
    foreach ($identity in @($managed.supervisor,$managed.daemon,$managed.desktop)) { Matching-Process $identity -CheckOwner | Out-Null }
    if (Test-Path -LiteralPath $backup) { throw 'Previous update backup requires review.' }
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($file in $files) {
        if (Test-Path -LiteralPath "$root\$file") { Copy-Item -LiteralPath "$root\$file" -Destination "$backup\$file" }
    }
    Save-Result
    # Stop-Managed may fail after the supervisor has already consumed the stop
    # request. Every subsequent failure must attempt recovery, not just copies.
    $stopRequested = $true
    Stop-Managed $managed
    # Mark before the first copy so a partial copy is also rolled back.
    $copied = $true
    foreach ($file in $files) { Copy-Item -LiteralPath "$PSScriptRoot\$file" -Destination "$root\$file" -Force }
    & "$root\configure-task.ps1"
    $result.managed = Start-Managed
    $result.ready = $true
    $result.sha256 = @{}
    foreach ($file in $files) { $result.sha256[$file] = (Get-FileHash -LiteralPath "$root\$file" -Algorithm SHA256).Hash.ToLowerInvariant() }
} catch {
    $result.error = $_.Exception.Message
    $result.errorAt = $_.InvocationInfo.PositionMessage
    if ($stopRequested) {
        try {
            $current = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json
            Stop-Managed $current
            if ($copied) {
                foreach ($file in $files) {
                    if (Test-Path -LiteralPath "$backup\$file") { Copy-Item -LiteralPath "$backup\$file" -Destination "$root\$file" -Force }
                    else { Remove-Item -LiteralPath "$root\$file" -Force -ErrorAction SilentlyContinue }
                }
            }
            $result.recovered = Start-Managed
            $result.rolledBack = $true
        } catch { $result.recoveryError = $_.Exception.Message; $result.recoveryErrorAt = $_.InvocationInfo.PositionMessage }
    }
} finally {
    if ($stopRequested) { Remove-Item -LiteralPath "$root\state\stop" -Force -ErrorAction SilentlyContinue }
    $result.finished = [DateTime]::UtcNow.ToString('o')
    Save-Result
    if ($result.ready -and (Split-Path -Parent $backup) -eq "$root\state") {
        foreach ($file in $files) { Remove-Item -LiteralPath "$backup\$file" -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $backup
    }
}
if (!$result.ready) { exit 1 }
