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
$stopped = $false
$result = @{started=[DateTime]::UtcNow.ToString('o');ready=$false;rolledBack=$false}

function Save-Result { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8 }
function Matching-Process($Identity) {
    if (!$Identity) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)"
    if (!$process) { return $null }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if ($process.CreationDate.ToUniversalTime().ToString('o') -ne $Identity.started -or $owner.Sid -ne $config.ownerSid -or $process.ExecutablePath -ne $Identity.executable) {
        throw 'Process identity changed; refusing to stop it.'
    }
    $process
}
function Stop-Managed($Managed) {
    New-Item -ItemType File -Path "$root\state\stop" -Force | Out-Null
    $until = (Get-Date).AddSeconds(30)
    do {
        $live = @(foreach ($identity in @($Managed.supervisor, $Managed.daemon, $Managed.desktop)) { Matching-Process $identity })
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
        if (!$state.supervisor -or ([DateTime]$state.supervisor.started) -lt $startedAfter) { continue }
        if ($state.daemonReady -and $state.toolsPipeReady -and $state.desktopBackendConnected) {
            foreach ($identity in @($state.supervisor,$state.daemon,$state.desktop)) {
                if (!(Matching-Process $identity)) { throw 'Ready state refers to an exited process.' }
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
    foreach ($identity in @($managed.supervisor,$managed.daemon,$managed.desktop)) { Matching-Process $identity | Out-Null }
    if (Test-Path -LiteralPath $backup) { throw 'Previous update backup requires review.' }
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($file in $files) {
        if (Test-Path -LiteralPath "$root\$file") { Copy-Item -LiteralPath "$root\$file" -Destination "$backup\$file" }
    }
    Save-Result
    Stop-Managed $managed
    $stopped = $true
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
    if ($stopped) {
        try {
            $current = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json
            Stop-Managed $current
            if ($copied) {
                foreach ($file in $files) {
                    if (Test-Path -LiteralPath "$backup\$file") { Copy-Item -LiteralPath "$backup\$file" -Destination "$root\$file" -Force }
                }
            }
            $result.recovered = Start-Managed
            $result.rolledBack = $true
        } catch { $result.recoveryError = $_.Exception.Message }
    }
} finally {
    $result.finished = [DateTime]::UtcNow.ToString('o')
    Save-Result
    if ($result.ready -and (Split-Path -Parent $backup) -eq "$root\state") {
        foreach ($file in $files) { Remove-Item -LiteralPath "$backup\$file" -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $backup
    }
}
if (!$result.ready) { exit 1 }
