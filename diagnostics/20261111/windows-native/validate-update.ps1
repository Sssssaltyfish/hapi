$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\..\deployment\windows-native'
$installed = Join-Path $env:LOCALAPPDATA 'HAPI\windows-native'
$runtime = & "$installed\resolve-runtime.ps1" -Config "$installed\config.json" | ConvertFrom-Json
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$id = [Guid]::NewGuid().ToString('N')
$fixture = Join-Path $PSScriptRoot ".update-fixture-$id"
$deployed = Join-Path $fixture 'installed'
$candidate = Join-Path $fixture 'candidate'
$badCandidate = Join-Path $fixture 'candidate-fail'
$testHome = Join-Path $fixture 'codex-home'
$statePath = Join-Path $deployed 'state'
$managedPath = Join-Path $statePath 'managed.json'
$stopPath = Join-Path $statePath 'stop'
$resultPath = Join-Path $statePath 'update-result.json'
$taskName = "HAPI Native Recovery Validation $id"
$registered = $false
$files = @('supervisor.mjs', 'process-info.ps1', 'run.ps1', 'install.ps1', 'configure-task.ps1', 'update.ps1', 'inspect.ps1', 'inspect.mjs')
$powerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$evidence = [ordered]@{
    at = [DateTime]::UtcNow.ToString('o')
    windowsBuild = (Get-CimInstance Win32_OperatingSystem).BuildNumber
    sourceSha256 = [ordered]@{}
    results = [ordered]@{}
    passed = $false
}

function Assert-Result($Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

function Wait-Result([scriptblock]$Check, [int]$Seconds, [string]$Message) {
    $until = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $value = & $Check
        if ($value) { return $value }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $until)
    throw $Message
}

function Read-Json([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    try {
        $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        try {
            $reader = [IO.StreamReader]::new($stream)
            $reader.ReadToEnd() | ConvertFrom-Json
        } finally { $stream.Dispose() }
    } catch [IO.IOException], [ArgumentException] {}
}

function Wait-Ready([int]$PreviousPid = 0) {
    Wait-Result {
        $state = Read-Json $managedPath
        if ($state.status -eq 'ready' -and $state.daemonReady -and $state.toolsPipeReady -and
            $state.desktopBackendConnected -and $state.supervisor.pid -ne $PreviousPid) { $state }
    } 30 'Isolated task did not publish ready state.'
}

function Assert-Owned($State) {
    Assert-Result ($State.daemon.probeConnection -and $State.daemon.endpointStates -contains 5) 'Initialize connection was not verified by its TCP tuple.'
    foreach ($identity in @($State.supervisor, $State.daemon, $State.desktop)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.pid)"
        Assert-Result ($process -and $process.ExecutablePath -eq $identity.executable -and
            $process.CreationDate.ToUniversalTime() -eq ([DateTimeOffset]$identity.started).UtcDateTime
        ) 'Recorded process identity is no longer running.'
        $processOwner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
        Assert-Result ($processOwner.Sid -eq $owner.User.Value) 'Recorded process owner changed.'
    }
}

function Assert-NewRun($Before, $After) {
    foreach ($name in @('supervisor', 'daemon', 'desktop')) {
        Assert-Result (($Before.$name.pid -ne $After.$name.pid -or $Before.$name.started -ne $After.$name.started) -and
            ([DateTimeOffset]$After.$name.started -gt [DateTimeOffset]$Before.$name.started)
        ) "Expected a fresh $name process."
    }
    Assert-Result (!(Test-Path -LiteralPath $stopPath)) 'Stop marker remained after restart.'
    Assert-Owned $After
}

function Get-FixtureHashes([string]$Directory) {
    $hashes = [ordered]@{}
    foreach ($file in $files) {
        $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $Directory $file)).Hash.ToLowerInvariant()
    }
    $hashes
}

function Invoke-FixtureUpdate([string]$CandidateDirectory, $Before, [switch]$ProbeStop, [switch]$FailStop) {
    $launcher = Join-Path $fixture 'invoke-update.ps1'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Candidate "{1}" -DeploymentRoot "{2}" -ExpectedPid {3} -ExpectedStarted "{4}"' -f
        $launcher, $CandidateDirectory, $deployed, $Before.supervisor.pid, $Before.supervisor.started
    if ($ProbeStop) { $arguments += ' -ProbeStop' }
    if ($FailStop) { $arguments += ' -FailStop' }
    $process = Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $fixture -WindowStyle Hidden -PassThru
    Assert-Result ($process.WaitForExit(110000)) 'Isolated updater did not exit.'
    [pscustomobject]@{ code = $process.ExitCode; receipt = Read-Json $resultPath }
}

try {
    $null = New-Item -ItemType Directory -Path $fixture, $deployed, $candidate, $badCandidate, $testHome, $statePath
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination $candidate
        Copy-Item -LiteralPath (Join-Path $candidate $file) -Destination $deployed
        Copy-Item -LiteralPath (Join-Path $candidate $file) -Destination $badCandidate
    }
    $evidence.sourceSha256 = Get-FixtureHashes $candidate
    Add-Content -LiteralPath "$deployed\process-info.ps1" -Value '# Initial fixture revision.' -Encoding ASCII
    Add-Content -LiteralPath "$badCandidate\process-info.ps1" -Value '# Failed candidate fixture revision.' -Encoding ASCII

    $desktopExe = Join-Path $fixture 'DesktopStandIn.exe'
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    @'
using System.Threading;
static class DesktopStandIn
{
    static void Main() { Thread.Sleep(Timeout.Infinite); }
}
'@ | Set-Content -LiteralPath "$fixture\DesktopStandIn.cs" -Encoding ASCII
    & $compiler /nologo /target:winexe "/out:$desktopExe" "$fixture\DesktopStandIn.cs"
    Assert-Result ($LASTEXITCODE -eq 0) 'Could not compile the isolated Desktop stand-in.'
    @'
param([string]$Config)
(Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json).fixtureRuntime | ConvertTo-Json -Compress
'@ | Set-Content -LiteralPath "$deployed\resolve-runtime.ps1" -Encoding ASCII
    @'
param([string]$ExpectedDesktopExe, [string]$OwnerSid, [int]$BackendPort)
$launch = Select-String -LiteralPath "$PSScriptRoot\state\events.jsonl" -Pattern '"event":"desktop-start"' -SimpleMatch | Select-Object -Last 1
$desktopPid = if ($launch) { ($launch.Line | ConvertFrom-Json).pid }
$desktop = if ($desktopPid) { Get-CimInstance Win32_Process -Filter "ProcessId=$desktopPid" }
if ($desktop -and $desktop.ExecutablePath -eq $ExpectedDesktopExe) {
    @{pipe='isolated-fixture';processId=$desktop.ProcessId;desktopProcessId=$desktop.ProcessId;backendConnected=$true} | ConvertTo-Json -Compress
} else { 'null' }
'@ | Set-Content -LiteralPath "$deployed\find-tools-pipe.ps1" -Encoding ASCII
    @'
$marker = "$PSScriptRoot\state\fixture-configure-failed"
if (!(Test-Path -LiteralPath $marker)) {
    New-Item -ItemType File -Path $marker | Out-Null
    throw 'Isolated configure failure'
}
'@ | Set-Content -LiteralPath "$badCandidate\configure-task.ps1" -Encoding ASCII

    @'
param([string]$Candidate, [string]$DeploymentRoot, [int]$ExpectedPid, [string]$ExpectedStarted, [switch]$ProbeStop, [switch]$FailStop)
$ErrorActionPreference = 'Stop'
function Get-CimInstance([string]$ClassName, [string]$Filter) {
    if ($ClassName -eq 'Win32_Process' -and $Filter -eq "ProcessId=$ExpectedPid" -and (Test-Path -LiteralPath "$DeploymentRoot\state\stop")) {
        if ($ProbeStop) { New-Item -ItemType File -Path "$DeploymentRoot\state\fixture-stop-identity-probe" -Force | Out-Null }
        $fault = "$DeploymentRoot\state\fixture-stop-query-failed"
        if ($FailStop -and !(Test-Path -LiteralPath $fault)) {
            # Confirm the old supervisor really stopped before injecting the query failure.
            $until = [DateTime]::UtcNow.AddSeconds(15)
            while ((CimCmdlets\Get-CimInstance Win32_Process -Filter $Filter) -and [DateTime]::UtcNow -lt $until) {
                Start-Sleep -Milliseconds 100
            }
            if (CimCmdlets\Get-CimInstance Win32_Process -Filter $Filter) { throw 'Fixture supervisor failed to exit' }
            New-Item -ItemType File -Path $fault | Out-Null
            throw 'Isolated process query failed after stop'
        }
    }
    CimCmdlets\Get-CimInstance @PSBoundParameters
}
function Invoke-CimMethod($InputObject, [string]$MethodName) {
    if ($ProbeStop -and $InputObject.ProcessId -eq $ExpectedPid -and (Test-Path -LiteralPath "$DeploymentRoot\state\fixture-stop-identity-probe")) {
        throw 'Unexpected owner lookup while stopping'
    }
    CimCmdlets\Invoke-CimMethod -InputObject $InputObject -MethodName $MethodName
}
& "$Candidate\update.ps1" -DeploymentRoot $DeploymentRoot -ExpectedSupervisorPid $ExpectedPid -ExpectedSupervisorStarted $ExpectedStarted
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath "$fixture\invoke-update.ps1" -Encoding ASCII

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $port = $listener.LocalEndpoint.Port
    } finally { $listener.Stop() }
    @{
        nodeExe = $runtime.nodeExe
        mcpNodeExe = $runtime.nodeExe
        browserNodeExe = $runtime.nodeExe
        codexHome = $testHome
        proxyEnvironment = @{}
        ownerSid = $owner.User.Value
        ownerTag = "update-test-$id"
        websocketUrl = "ws://127.0.0.1:$port"
        taskName = $taskName
        fixtureRuntime = @{
            cliExe = $runtime.cliExe
            desktopExe = $desktopExe
            nodeExe = $runtime.nodeExe
            resourcesPath = $runtime.resourcesPath
        }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$deployed\config.json" -Encoding UTF8

    $launcher = Join-Path $env:LOCALAPPDATA 'HAPI\hidden-task-launcher\HiddenTaskLauncher.exe'
    $action = New-ScheduledTaskAction -Execute $launcher -Argument ('"{0}\run.ps1" "{0}" Bypass' -f $deployed) -WorkingDirectory $deployed
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner.Name
    $principal = New-ScheduledTaskPrincipal -UserId $owner.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    $null = Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    $registered = $true

    $null = New-Item -ItemType File -Path $stopPath
    Start-ScheduledTask -TaskPath '\' -TaskName $taskName
    $first = Wait-Ready
    Assert-Owned $first
    Assert-Result (!(Test-Path -LiteralPath $stopPath)) 'A stale stop marker blocked an explicit start.'
    $evidence.results.staleStop = @{ ready = $true; stopMarkerAbsent = $true; supervisorPid = $first.supervisor.pid }

    $null = New-Item -ItemType File -Path $stopPath
    $null = Wait-Result {
        $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName
        if ($task.State -ne 'Running' -and (Read-Json $managedPath).status -eq 'stopped') { $true }
    } 20 'Isolated scheduled task did not stop.'
    $stopReceipt = Read-Json "$statePath\stopped.json"
    Assert-Result ($stopReceipt.reason -eq 'requested' -and $stopReceipt.exitCode -eq 0 -and !(Test-Path -LiteralPath $stopPath)) 'Active stop marker was not consumed cleanly.'
    Start-ScheduledTask -TaskPath '\' -TaskName $taskName
    $second = Wait-Ready -PreviousPid $first.supervisor.pid
    Assert-NewRun $first $second
    $evidence.results.requestedStopAndRestart = @{ stopExit = $stopReceipt.exitCode; stopMarkerAbsent = $true; oldSupervisorPid = $first.supervisor.pid; newSupervisorPid = $second.supervisor.pid }

    $beforeFault = Get-FixtureHashes $deployed
    $stopFailure = Invoke-FixtureUpdate $candidate $second -FailStop
    Assert-Result ($stopFailure.code -eq 1 -and !$stopFailure.receipt.ready -and $stopFailure.receipt.rolledBack -and
        $stopFailure.receipt.error -eq 'Isolated process query failed after stop' -and !$stopFailure.receipt.recoveryError
    ) ('Failure before file copy did not recover. ' + ($stopFailure.receipt | ConvertTo-Json -Depth 4 -Compress))
    Assert-Result (Test-Path -LiteralPath "$statePath\fixture-stop-query-failed") 'The stop query failure did not run.'
    $recovered = Wait-Ready -PreviousPid $second.supervisor.pid
    Assert-NewRun $second $recovered
    $afterFault = Get-FixtureHashes $deployed
    foreach ($file in $files) { Assert-Result ($beforeFault[$file] -eq $afterFault[$file]) "Pre-copy failure changed $file." }
    $evidence.results.stopQueryFailure = @{ exitCode = $stopFailure.code; stopMarkerAbsent = $true; oldSupervisorPid = $second.supervisor.pid; recoveredSupervisorPid = $recovered.supervisor.pid; originalHashesPreserved = $true }
    foreach ($file in $files) { Remove-Item -LiteralPath "$statePath\update-backup\$file" }
    Remove-Item -LiteralPath "$statePath\update-backup"

    $update = Invoke-FixtureUpdate $candidate $recovered -ProbeStop
    Assert-Result ($update.code -eq 0 -and $update.receipt.ready -and !$update.receipt.rolledBack) ('Isolated cutover failed. ' + ($update.receipt | ConvertTo-Json -Depth 4 -Compress))
    Assert-Result (Test-Path -LiteralPath "$statePath\fixture-stop-identity-probe") 'The update did not query the old process during stop.'
    $third = Wait-Ready -PreviousPid $recovered.supervisor.pid
    Assert-NewRun $recovered $third
    $baseline = Get-FixtureHashes $deployed
    foreach ($file in $files) { Assert-Result ($baseline[$file] -eq $evidence.sourceSha256[$file]) "Candidate file $file was not installed." }
    $configured = Get-ScheduledTask -TaskPath '\' -TaskName $taskName
    Assert-Result ($configured.Settings.StartWhenAvailable -and $configured.Settings.RestartCount -eq 3 -and
        $configured.Settings.RestartInterval -eq 'PT1M' -and $configured.Triggers[0].Delay -eq 'PT10S'
    ) 'Candidate task recovery settings were not applied.'
    $evidence.results.cutover = @{ exitCode = $update.code; noOwnerLookupDuringStop = $true; stopMarkerAbsent = $true; oldSupervisorPid = $recovered.supervisor.pid; newSupervisorPid = $third.supervisor.pid; candidateHashesMatch = $true; taskRecoveryConfigured = $true }

    $failure = Invoke-FixtureUpdate $badCandidate $third
    Assert-Result ($failure.code -eq 1 -and !$failure.receipt.ready -and $failure.receipt.rolledBack -and
        $failure.receipt.error -eq 'Isolated configure failure' -and !$failure.receipt.recoveryError
    ) ('Isolated configure failure did not roll back. ' + ($failure.receipt | ConvertTo-Json -Depth 4 -Compress))
    Assert-Result (Test-Path -LiteralPath "$statePath\fixture-configure-failed") 'The injected configure failure did not run.'
    $fourth = Wait-Ready -PreviousPid $third.supervisor.pid
    Assert-NewRun $third $fourth
    $restored = Get-FixtureHashes $deployed
    foreach ($file in $files) { Assert-Result ($restored[$file] -eq $baseline[$file]) "Rollback did not restore $file." }
    $evidence.results.rollback = @{ exitCode = $failure.code; stopMarkerAbsent = $true; oldSupervisorPid = $third.supervisor.pid; recoveredSupervisorPid = $fourth.supervisor.pid; originalHashesRestored = $true }
    $evidence.passed = $true
} catch {
    $evidence.error = $_.Exception.Message
    throw
} finally {
    try {
        if ($registered) {
            $null = New-Item -ItemType File -Path $stopPath -Force
            $null = Wait-Result {
                (Get-ScheduledTask -TaskPath '\' -TaskName $taskName).State -ne 'Running'
            } 15 'Isolated task remained running during cleanup.'
        }
    } finally {
        if ($registered) {
            Stop-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskPath '\' -TaskName $taskName -Confirm:$false
        }
        $evidence.validationTaskRemoved = !(Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue)
        if ($evidence.passed) {
            $resolved = (Resolve-Path -LiteralPath $fixture).ProviderPath
            Assert-Result ((Split-Path -Parent $resolved) -eq $PSScriptRoot -and (Split-Path -Leaf $resolved) -match '^\.update-fixture-[a-f0-9]{32}$') 'Unexpected fixture path.'
            Assert-Result (!(Get-ChildItem -LiteralPath $resolved -Recurse -Force -Attributes ReparsePoint)) 'Fixture tree contains a reparse point.'
            for ($attempt = 1; $attempt -le 8; $attempt++) {
                try { Remove-Item -LiteralPath $resolved -Recurse -Force; break }
                catch [IO.IOException], [UnauthorizedAccessException] {
                    if ($attempt -eq 8) { throw }
                    Start-Sleep -Milliseconds 350
                }
            }
            $evidence.fixtureRemoved = !(Test-Path -LiteralPath $resolved)
        } else {
            $evidence.fixturePath = $fixture
        }
        $evidence | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath "$PSScriptRoot\validation-update.json" -Encoding UTF8
    }
}
