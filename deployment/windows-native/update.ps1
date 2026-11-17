[CmdletBinding(DefaultParameterSetName='Running')]
param(
    [Parameter(Mandatory)][string]$DeploymentRoot,
    [Parameter(Mandatory, ParameterSetName='Running')][ValidateRange(1,2147483647)][int]$ExpectedSupervisorPid,
    [Parameter(Mandatory, ParameterSetName='Running')][string]$ExpectedSupervisorStarted,
    [Parameter(Mandatory, ParameterSetName='Stopped')][switch]$Stopped,
    [string]$CandidateConfig,
    [string]$CandidateTaskXml
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\native-task.ps1"
. "$PSScriptRoot\live-backend.ps1"
$root = (Resolve-Path -LiteralPath $DeploymentRoot).ProviderPath
if ($root -eq $PSScriptRoot) { throw 'Run the update from a separate candidate directory.' }
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$files = @(Get-CodexNativePayload)
$resultPath = "$root\state\update-result.json"
$backup = "$root\state\update-backup"
$copied = $false
$stopRequested = $false
$startRequested = $false
$idleLease = $null
$backupCreated = $false
$result = @{started=[DateTime]::UtcNow.ToString('o');ready=$false;rolledBack=$false;mode=$PSCmdlet.ParameterSetName}
if ($PSCmdlet.ParameterSetName -eq 'Stopped' -and !$Stopped) { throw 'Pass -Stopped to update an idle deployment.' }

function Save-Result { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8 }

function Get-BackendTask {
    Get-CodexDeploymentTask -Root $root -Name $config.taskName -OwnerSid $ownerSid -Entry 'run.ps1' -AllowLegacy
}

function Assert-Stopped($Registered) {
    if ($Registered.GetInstances(0).Count) { throw 'The verified backend task is active. Use the running update with its live supervisor identity.' }
    $url = [Uri]$config.websocketUrl
    if ($url.Scheme -ne 'ws' -or $url.Host -ne '127.0.0.1' -or $url.Port -lt 1024 -or $url.AbsolutePath -ne '/' -or
        $url.UserInfo -or $url.Query -or $url.Fragment) { throw 'The configured endpoint must be a loopback WebSocket.' }
    $module = [regex]::Escape((Join-Path $root 'supervisor.mjs'))
    $endpoint = [regex]::Escape($config.websocketUrl)
    $program = '^\s*(?:"[^"]+"|\S+)\s+'
    foreach ($process in Get-CimInstance Win32_Process) {
        if (($process.ExecutablePath -eq $config.nodeExe -and $process.CommandLine -match ($program + '(?:"' + $module + '"|' + $module + ')\s*$')) -or
            ($process.CommandLine -match ($program + 'app-server\s+--listen\s+(?:"' + $endpoint + '"|' + $endpoint + ')(?:\s|$)'))) {
            throw 'A supervisor for this deployment or a process targeting its endpoint is still present.'
        }
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $url.Port)
    $listener.ExclusiveAddressUse = $true
    try { $listener.Start() }
    catch { throw 'The configured loopback port is unavailable. The updater did not stop its owner.' }
    finally { $listener.Stop() }
}

function Get-DisabledTaskXml([string]$Xml) {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $definition = $service.NewTask(0)
    $definition.XmlText = $Xml
    $definition.Settings.Enabled = $false
    $definition.XmlText
}

function Stop-Managed($Proof) {
    $task = Get-BackendTask
    Disable-ScheduledTask -TaskName $task.TaskName -TaskPath '\' | Out-Null
    $registered = $taskFolder.GetTask($task.TaskName)
    $until = (Get-Date).AddSeconds(30)
    New-Item -ItemType File -Path "$root\state\stop" -Force | Out-Null
    do {
        if (!$registered.GetInstances(0).Count) {
            $lease = $null
            try {
                $lease = [IO.File]::Open("$root\state\supervisor.lock", 'OpenOrCreate', 'ReadWrite', 'None')
            } catch [IO.IOException] {
                if (($_.Exception.HResult -band 0xffff) -notin @(32,33)) { throw }
            }
            if ($lease) {
                try {
                    if (!$Proof.ok -or (!(Test-CodexProcessGeneration $Proof.supervisor) -and
                        !(Test-CodexProcessGeneration $Proof.daemon))) { return }
                } finally { $lease.Dispose(); $lease = $null }
            }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $until)
    throw 'The verified backend and its task did not finish shutdown.'
}

function Start-Managed {
    $task = Get-BackendTask
    Remove-Item -LiteralPath "$root\state\stop" -Force -ErrorAction SilentlyContinue
    $startedAfter = [DateTime]::UtcNow
    Enable-ScheduledTask -TaskName $task.TaskName -TaskPath '\' | Out-Null
    Start-ScheduledTask -TaskName $task.TaskName -TaskPath '\'
    $registered = $taskFolder.GetTask($task.TaskName)
    $until = (Get-Date).AddSeconds(90)
    do {
        $proof = Get-CodexLiveBackend -Config $config -DeploymentRoot $root -StartedAfter $startedAfter
        if ($proof.ok -and $registered.GetInstances(0).Count -and $proof.supervisor.sessionId -eq $proof.daemon.sessionId -and
            (($task.Principal.LogonType -eq 'S4U') -eq ($proof.supervisor.sessionId -eq 0))) { return $proof }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $until)
    throw "The managed backend did not become ready ($($proof.code))."
}

if (!(Test-Path -LiteralPath "$root\state" -PathType Container)) { throw 'Managed deployment state directory is unavailable.' }
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
if ($config.ownerSid -ne $ownerSid) { throw 'Run the update as the deployment owner.' }
$migrationLock = [IO.File]::Open("$root\state\switch.lock", 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
    if ($config.ownerSid -ne $ownerSid) { throw 'Run the update as the deployment owner.' }
    if ([bool]$CandidateConfig -ne [bool]$CandidateTaskXml) { throw 'Provide the candidate configuration and task XML together.' }
    if (Test-Path -LiteralPath "$root\state\switch-request.json") { throw 'A switch is already scheduled.' }
    $task = Get-BackendTask
    $taskFolder = Get-CodexTaskFolder
    $registered = $taskFolder.GetTask($task.TaskName)
    $wasEnabled = [bool]$registered.Enabled
    if ($Stopped) { Assert-Stopped $registered }
    elseif (!$wasEnabled -or !$registered.GetInstances(0).Count) { throw 'The verified backend task is not running. Use -Stopped for an idle deployment.' }
    $previousTaskXml = $registered.Xml
    if ($CandidateConfig) {
        $nextConfigText = Get-Content -LiteralPath $CandidateConfig -Raw
        $nextConfig = $nextConfigText | ConvertFrom-Json
        foreach ($key in @('ownerSid','ownerTag','taskName','codexHome','websocketUrl')) {
            if ($nextConfig.$key -cne $config.$key) { throw "Candidate changed deployment identity field $key." }
        }
        if ($config.desktopTaskName -and $nextConfig.desktopTaskName -ne $config.desktopTaskName) {
            throw 'The existing Desktop task must keep its configured name.'
        }
        if ($nextConfig.desktopTaskName) {
            $null = Get-CodexDeploymentTask -Root $root -Name $nextConfig.desktopTaskName -OwnerSid $ownerSid -Entry 'desktop.ps1'
        }
        $nextTaskXml = Get-Content -LiteralPath $CandidateTaskXml -Raw
        Assert-CodexCandidateTask $root $ownerSid $nextTaskXml
        $nextTaskXml = Get-DisabledTaskXml $nextTaskXml
    }
    foreach ($file in $files) {
        if (!(Test-Path -LiteralPath "$PSScriptRoot\$file" -PathType Leaf)) { throw "Candidate file missing: $file" }
    }
    if (!$Stopped) {
        $previous = Get-CodexLiveBackend -Config $config -DeploymentRoot $root
        if (!$previous.ok) { throw "The current backend identity could not be verified ($($previous.code))." }
        if ($previous.supervisor.pid -ne $ExpectedSupervisorPid -or
            ([DateTimeOffset]$previous.supervisor.started).UtcDateTime -ne ([DateTimeOffset]$ExpectedSupervisorStarted).UtcDateTime) {
            throw 'The live supervisor changed since the update was prepared.'
        }
    }
    if (Test-Path -LiteralPath $backup) { throw 'Previous update backup requires review.' }
    New-Item -ItemType Directory -Path $backup | Out-Null
    $backupCreated = $true
    foreach ($file in $files) {
        if (Test-Path -LiteralPath "$root\$file") { Copy-Item -LiteralPath "$root\$file" -Destination "$backup\$file" }
    }
    if ($CandidateConfig) { Copy-Item -LiteralPath "$root\config.json" -Destination "$backup\config.json" }
    $previousTaskXml | Set-Content -LiteralPath "$backup\task.xml" -Encoding Unicode
    Save-Result

    $stopRequested = $true
    if ($Stopped) {
        Disable-ScheduledTask -TaskName $task.TaskName -TaskPath '\' | Out-Null
        try { $idleLease = [IO.File]::Open("$root\state\supervisor.lock", 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] { throw 'The supervisor lock is unavailable. An idle update requires shutdown to finish.' }
        Assert-Stopped $registered
    } else { Stop-Managed $previous }
    $copied = $true
    foreach ($file in $files) { Copy-Item -LiteralPath "$PSScriptRoot\$file" -Destination "$root\$file" -Force }
    if ($CandidateConfig) {
        Set-Content -LiteralPath "$root\config.json" -Value $nextConfigText -Encoding UTF8
        $config = $nextConfig
        Register-ScheduledTask -TaskName $config.taskName -TaskPath '\' -Xml $nextTaskXml -Force | Out-Null
    } else { & "$root\configure-task.ps1" }

    if ($idleLease) { $idleLease.Dispose(); $idleLease = $null }
    $startRequested = $true
    $result.managed = Start-Managed
    $result.backendRunning = $true
    $result.sha256 = @{}
    foreach ($file in $files) { $result.sha256[$file] = (Get-FileHash -LiteralPath "$root\$file" -Algorithm SHA256).Hash.ToLowerInvariant() }
    if ($Stopped -and !$wasEnabled) {
        Stop-Managed $result.managed
        Remove-Item -LiteralPath "$root\state\stop" -Force -ErrorAction SilentlyContinue
        $result.backendRunning = $false
    }
    $result.ready = $true
} catch {
    $result.error = $_.Exception.Message
    $result.errorAt = $_.InvocationInfo.PositionMessage
    if ($stopRequested) {
        try {
            if (!$Stopped -or $startRequested) {
                $current = Get-CodexLiveBackend -Config $config -DeploymentRoot $root
                Stop-Managed $current
            }
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
            if ($copied -or !$Stopped) {
                $restoreXml = Get-DisabledTaskXml $previousTaskXml
                Register-ScheduledTask -TaskName $config.taskName -TaskPath '\' -Xml $restoreXml -Force | Out-Null
            }
            if ($Stopped) {
                if ($startRequested) { Remove-Item -LiteralPath "$root\state\stop" -Force -ErrorAction SilentlyContinue }
                if ($wasEnabled) { Enable-ScheduledTask -TaskName $config.taskName -TaskPath '\' | Out-Null }
                $result.backendRunning = [bool]$taskFolder.GetTask($config.taskName).GetInstances(0).Count
            } else {
                $result.recovered = Start-Managed
                $result.backendRunning = $true
            }
            $result.rolledBack = $true
        } catch { $result.recoveryError = $_.Exception.Message; $result.recoveryErrorAt = $_.InvocationInfo.PositionMessage }
    }
} finally {
    try {
        $result.finished = [DateTime]::UtcNow.ToString('o')
        Save-Result
        if ($backupCreated -and ($result.ready -or $result.rolledBack -or !$stopRequested)) {
            foreach ($file in $files) { Remove-Item -LiteralPath "$backup\$file" -Force -ErrorAction SilentlyContinue }
            Remove-Item -LiteralPath "$backup\config.json","$backup\task.xml" -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $backup -Force
        }
    } finally {
        if ($idleLease) { $idleLease.Dispose() }
        $migrationLock.Dispose()
    }
}
if (!$result.ready) { exit 1 }
exit 0
