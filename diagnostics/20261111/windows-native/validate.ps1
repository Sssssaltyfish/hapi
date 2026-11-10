[CmdletBinding()]
param([switch]$Scheduler)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\..\deployment\windows-native'
$live = Join-Path $env:LOCALAPPDATA 'HAPI\windows-native'
$runtime = & "$live\resolve-runtime.ps1" -Config "$live\config.json" | ConvertFrom-Json
$powerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$testRoot = Join-Path $PSScriptRoot ('.fixture-' + [Guid]::NewGuid().ToString('N'))
$snapshot = Join-Path $testRoot 'candidate'
$null = New-Item -ItemType Directory -Path $testRoot, $snapshot
$candidateFiles = @('run.ps1', 'supervisor.mjs', 'process-info.ps1')
$evidenceName = if ($Scheduler) { 'validation-scheduler.json' } else { 'validation.json' }
$evidence = [ordered]@{
    at = [DateTime]::UtcNow.ToString('o')
    windowsBuild = (Get-CimInstance Win32_OperatingSystem).BuildNumber
    sourceSha256 = [ordered]@{}
    results = [ordered]@{}
    passed = $false
}
$cases = @()
$validationTask = $null

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

function Read-State([string]$Case, [string]$Name) {
    $file = Join-Path $Case "state\$Name.json"
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        try { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch [IO.IOException] {}
    }
}

function New-Fixture([string]$Name, [string]$OwnerSid = $owner.User.Value) {
    $casePath = Join-Path $testRoot $Name
    $homePath = Join-Path $casePath 'codex-home'
    $null = New-Item -ItemType Directory -Path $casePath, $homePath, "$casePath\state"
    foreach ($nameToCopy in $candidateFiles) {
        Copy-Item -LiteralPath (Join-Path $snapshot $nameToCopy) -Destination $casePath
    }

    # The stand-in uses the same installed Node and never starts the real Desktop.
    @'
if (process.argv.length === 1 && process.env.CODEX_APP_SERVER_WS_URL) {
    setInterval(() => {}, 1000);
}
'@ | Set-Content -LiteralPath "$homePath\desktop-stand-in.cjs" -Encoding ASCII
    @'
param([string]$Config)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath "$PSScriptRoot\fail-resolver") { throw 'Isolated resolver failure' }
(Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json).fixtureRuntime | ConvertTo-Json -Compress
'@ | Set-Content -LiteralPath "$casePath\resolve-runtime.ps1" -Encoding ASCII
    @'
param([string]$ExpectedDesktopExe, [string]$OwnerSid, [int]$BackendPort)
if (Test-Path -LiteralPath "$PSScriptRoot\hold-watcher") {
    $null = New-Item -ItemType File -Path "$PSScriptRoot\watcher-entered" -Force
    $until = [DateTime]::UtcNow.AddSeconds(3)
    while (!(Test-Path -LiteralPath "$PSScriptRoot\release-watcher") -and [DateTime]::UtcNow -lt $until) {
        Start-Sleep -Milliseconds 15
    }
}
'null'
'@ | Set-Content -LiteralPath "$casePath\find-tools-pipe.ps1" -Encoding ASCII

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $port = $listener.LocalEndpoint.Port
    } finally { $listener.Stop() }
    @{
        nodeExe = $runtime.nodeExe
        mcpNodeExe = $runtime.nodeExe
        browserNodeExe = $runtime.nodeExe
        codexHome = $homePath
        proxyEnvironment = @{ NODE_OPTIONS = '--require=./desktop-stand-in.cjs' }
        ownerSid = $OwnerSid
        ownerTag = 'recovery-test-' + [Guid]::NewGuid().ToString('N')
        websocketUrl = "ws://127.0.0.1:$port"
        fixtureRuntime = @{
            cliExe = $runtime.cliExe
            desktopExe = $runtime.nodeExe
            nodeExe = $runtime.nodeExe
            resourcesPath = $runtime.resourcesPath
        }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$casePath\config.json" -Encoding UTF8
    [pscustomobject]@{ path = $casePath; port = $port; run = $null }
}

function Start-Fixture($Fixture, [switch]$Direct) {
    if ($Direct) {
        $executable = $runtime.nodeExe
        $arguments = '"{0}\supervisor.mjs"' -f $Fixture.path
    } else {
        $executable = $powerShell
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}\run.ps1"' -f $Fixture.path
    }
    $Fixture.run = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $Fixture.path -WindowStyle Hidden -PassThru
}

function Wait-Ready($Fixture, [int]$PreviousDaemon = 0, [int]$Seconds = 35, [switch]$AllowRetry) {
    Wait-Result {
        $state = Read-State $Fixture.path 'managed'
        if ($state.status -eq 'failed' -and (!$AllowRetry -or $Fixture.run.HasExited)) {
            $failure = $state.failure | ConvertTo-Json -Compress
            throw "Isolated startup failed. $failure"
        }
        if ($state.status -eq 'ready' -and $state.daemonReady -and
            $state.daemon.pid -and $state.daemon.pid -ne $PreviousDaemon) { $state }
    } $Seconds 'Timed out waiting for a verified isolated daemon.'
}

function Assert-OwnedDaemon($State, $Fixture) {
    Assert-Result ($State.daemon.probeConnection -eq $true) 'No reverse TCP tuple matched the initialize probe.'
    Assert-Result ($State.daemon.endpointStates -contains 5) 'The daemon did not own the established TCP endpoint.'
    Assert-Result ($State.url -eq "ws://127.0.0.1:$($Fixture.port)") 'Isolated backend URL mismatch.'
    Assert-Result ($State.daemon.executable -eq $runtime.cliExe) 'Daemon executable mismatch.'
    Assert-Result ($State.daemon.ownerSid -eq $owner.User.Value) 'Daemon owner mismatch.'
    $daemon = Get-CimInstance Win32_Process -Filter "ProcessId=$($State.daemon.pid)"
    Assert-Result ($daemon -and $daemon.ParentProcessId -eq $State.supervisor.pid -and
        $daemon.ExecutablePath -eq $runtime.cliExe -and
        $daemon.CreationDate.ToUniversalTime() -eq ([DateTimeOffset]$State.daemon.started).UtcDateTime
    ) 'Daemon process identity changed.'
}

function Get-ChildExitCode($Fixture) {
    Assert-Result ($Fixture.run.WaitForExit(70000)) 'Isolated PowerShell launcher did not exit.'
    return $Fixture.run.ExitCode
}

function Assert-RequestedStop($Fixture) {
    $state = Read-State $Fixture.path 'managed'
    $stopped = Read-State $Fixture.path 'stopped'
    Assert-Result ($state.status -eq 'stopped' -and !$state.daemonReady -and !$state.toolsPipeReady -and !$state.desktopBackendConnected) 'Requested stop left managed readiness set.'
    Assert-Result ($stopped.exitCode -eq 0 -and $stopped.reason -eq 'requested') 'Requested stop receipt mismatch.'
}

function Test-ConcurrentStateReader($Fixture) {
    $null = Wait-Result {
        Test-Path -LiteralPath "$($Fixture.path)\watcher-entered"
    } 10 'The isolated watcher did not enter the pipe helper.'
    $before = Read-State $Fixture.path 'managed'
    $statePath = Join-Path $Fixture.path 'state\managed.json'
    $locked = [IO.File]::Open($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $null = New-Item -ItemType File -Path "$($Fixture.path)\release-watcher"
        Start-Sleep -Milliseconds 350
        $pendingWrite = Test-Path -LiteralPath "$statePath.tmp" -PathType Leaf
        Assert-Result $pendingWrite 'The watcher did not attempt an atomic state write while the reader held the destination.'
    } finally { $locked.Dispose() }
    $null = Wait-Result {
        $state = Read-State $Fixture.path 'managed'
        if ($state.daemonReady -and $state.at -ne $before.at) { $true }
    } 2 'State publication did not recover after the reader released the destination.'
    $watchFailure = Select-String -LiteralPath "$($Fixture.path)\state\events.jsonl" -Pattern '"event":"watch-failed"' -SimpleMatch
    Assert-Result (!$watchFailure) 'The watcher reported failure during a temporary reader lock.'
}

function Stop-Fixture($Fixture) {
    if (!$Fixture) { return }
    $null = New-Item -ItemType File -Path "$($Fixture.path)\state\stop" -Force
    if ($Fixture.run -and !$Fixture.run.HasExited) { $null = $Fixture.run.WaitForExit(7000) }
    $entryPoint = Join-Path $Fixture.path 'supervisor.mjs'
    $nodeName = Split-Path -Leaf $runtime.nodeExe
    $workers = @(Get-CimInstance Win32_Process -Filter "Name='$nodeName'" | Where-Object {
        $_.ExecutablePath -eq $runtime.nodeExe -and $_.CommandLine -and $_.CommandLine.Contains($entryPoint)
    })
    foreach ($worker in $workers) {
        $workerOwner = Invoke-CimMethod -InputObject $worker -MethodName GetOwnerSid
        if ($workerOwner.Sid -eq $owner.User.Value) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $worker.ProcessId /T /F 2>$null | Out-Null
        }
    }
}

function Remove-FixtureTree {
    $resolved = (Resolve-Path -LiteralPath $testRoot).ProviderPath
    Assert-Result ((Split-Path -Parent $resolved) -eq $PSScriptRoot -and
        (Split-Path -Leaf $resolved) -match '^\.fixture-[a-f0-9]{32}$') 'Fixture path outside validation workspace.'
    $reparsePoints = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force -Attributes ReparsePoint)
    Assert-Result (!$reparsePoints) 'Fixture tree contains a reparse point.'
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            Remove-Item -LiteralPath $resolved -Recurse -Force
            return
        } catch [IO.IOException], [UnauthorizedAccessException] {
            if ($attempt -eq 10) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
}

function Get-FixtureEvents($Fixture, [string]$Name) {
    $file = Join-Path $Fixture.path 'state\events.jsonl'
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        Get-Content -LiteralPath $file | ForEach-Object {
            if ($_ -and ($_ -match '"event"\s*:\s*"' + [regex]::Escape($Name) + '"')) { $_ | ConvertFrom-Json }
        }
    }
}

try {
    foreach ($nameToCopy in $candidateFiles) {
        $copied = Join-Path $snapshot $nameToCopy
        Copy-Item -LiteralPath (Join-Path $source $nameToCopy) -Destination $copied
        $evidence.sourceSha256[$nameToCopy] = (Get-FileHash -LiteralPath $copied).Hash.ToLowerInvariant()
    }
    $regular = New-Fixture 'normal'
    $cases += $regular
    $null = New-Item -ItemType File -Path "$($regular.path)\hold-watcher"
    Start-Fixture $regular
    $initial = Wait-Ready $regular
    Assert-OwnedDaemon $initial $regular
    $null = Wait-Result {
        $event = Select-String -LiteralPath "$($regular.path)\state\events.jsonl" -Pattern '"event":"desktop-start"' -SimpleMatch
        if ($event) { $true }
    } 10 'The isolated stand-in did not launch.'
    $evidence.results.initialize = @{
        daemonPid = $initial.daemon.pid
        supervisorPid = $initial.supervisor.pid
        endpointStates = @($initial.daemon.endpointStates)
        listenerStateRecognized = $initial.daemon.listening
        verifiedReverseTuple = $initial.daemon.probeConnection
        codexHomeIsolated = $true
    }
    Test-ConcurrentStateReader $regular
    $evidence.results.concurrentStateReader = @{ heldOpenMs = 350; recovered = $true }

    Assert-OwnedDaemon $initial $regular
    Stop-Process -Id $initial.daemon.pid -Force
    $replacement = Wait-Ready $regular -PreviousDaemon $initial.daemon.pid
    Assert-OwnedDaemon $replacement $regular
    Assert-Result ($initial.supervisor.pid -eq $replacement.supervisor.pid) 'The supervisor exited during the daemon replacement.'
    $evidence.results.daemonRecovery = @{
        previousDaemonPid = $initial.daemon.pid
        replacementDaemonPid = $replacement.daemon.pid
        supervisorPid = $replacement.supervisor.pid
        port = $regular.port
        verifiedReverseTuple = $replacement.daemon.probeConnection
    }

    $null = New-Item -ItemType File -Path "$($regular.path)\state\stop"
    $regularExit = Get-ChildExitCode $regular
    Assert-Result ($regularExit -eq 0) 'Requested stop did not return zero through run.ps1.'
    Assert-RequestedStop $regular
    $evidence.results.requestedStop = @{ exitCode = $regularExit; status = 'stopped'; daemonReady = $false }

    $fault = New-Fixture 'resolver-failure'
    $cases += $fault
    $null = New-Item -ItemType File -Path "$($fault.path)\fail-resolver"
    Start-Fixture $fault -Direct
    $faultExit = Get-ChildExitCode $fault
    $faultState = Read-State $fault.path 'managed'
    $faultReceipt = Read-State $fault.path 'stopped'
    Assert-Result ($faultExit -eq 1 -and $faultReceipt.exitCode -eq 1 -and $faultState.status -eq 'failed' -and !$faultState.daemonReady) 'Resolver failure did not return one and clear readiness.'
    Assert-Result ($faultReceipt.reason -eq 'startup-failed') 'Resolver failure did not record the startup failure reason.'
    $evidence.results.resolverFailure = @{ exitCode = $faultExit; status = $faultState.status; reason = $faultReceipt.reason; daemonReady = $faultState.daemonReady }

    $identityFault = New-Fixture 'identity-mismatch' -OwnerSid 'S-1-5-18'
    $cases += $identityFault
    Start-Fixture $identityFault -Direct
    $identityExit = Get-ChildExitCode $identityFault
    $identityState = Read-State $identityFault.path 'managed'
    $identityReceipt = Read-State $identityFault.path 'stopped'
    $identityCheck = Get-FixtureEvents $identityFault 'daemon-identity-check' | Select-Object -Last 1
    Assert-Result ($identityExit -eq 1 -and $identityState.status -eq 'failed' -and !$identityState.daemonReady -and
        $identityReceipt.reason -eq 'startup-failed' -and $identityReceipt.failure.message -eq 'Backend identity mismatch: process' -and
        $identityCheck.checks.process -eq $false -and $identityCheck.probeConnection -eq $true
    ) 'The supervisor did not reject an initialized backend with an incorrect process owner.'
    $evidence.results.identityMismatch = @{
        exitCode = $identityExit
        status = $identityState.status
        verifiedReverseTuple = $identityCheck.probeConnection
        processOwnerAccepted = $identityCheck.checks.process
    }

    $permanent = New-Fixture 'wrapper-permanent-failure'
    $cases += $permanent
    $null = New-Item -ItemType File -Path "$($permanent.path)\fail-resolver"
    Start-Fixture $permanent
    $transient = New-Fixture 'wrapper-transient-failure'
    $cases += $transient
    $null = New-Item -ItemType File -Path "$($transient.path)\fail-resolver"
    Start-Fixture $transient
    $retry = Wait-Result {
        Get-FixtureEvents $transient 'supervisor-retry' | Select-Object -First 1
    } 15 'PowerShell did not retry the failed supervisor.'
    Assert-Result ($retry.attempt -eq 1 -and $retry.delaySeconds -eq 5 -and $retry.exitCode -eq 1) 'Unexpected first wrapper retry.'
    Remove-Item -LiteralPath "$($transient.path)\fail-resolver"
    $transientState = Wait-Ready $transient -AllowRetry
    Assert-OwnedDaemon $transientState $transient
    Assert-Result (!$transient.run.HasExited) 'A different task took over during the wrapper retry.'
    $null = New-Item -ItemType File -Path "$($transient.path)\state\stop"
    $transientExit = Get-ChildExitCode $transient
    Assert-Result ($transientExit -eq 0) 'The recovered wrapper did not exit zero on requested stop.'
    Assert-RequestedStop $transient
    $evidence.results.wrapperTransientFailure = @{
        firstFailureExitCode = $retry.exitCode
        firstDelaySeconds = $retry.delaySeconds
        recoveredDaemonPid = $transientState.daemon.pid
        requestedStopExitCode = $transientExit
    }
    $permanentExit = Get-ChildExitCode $permanent
    $permanentState = Read-State $permanent.path 'managed'
    $permanentRetries = @(Get-FixtureEvents $permanent 'supervisor-retry')
    Assert-Result ($permanentExit -eq 1 -and $permanentState.status -eq 'failed' -and !$permanentState.daemonReady -and
        ($permanentRetries.delaySeconds -join ',') -eq '5,15,30'
    ) 'PowerShell did not exhaust the configured retries and propagate exit code one.'
    $evidence.results.wrapperPermanentFailure = @{
        exitCode = $permanentExit
        status = $permanentState.status
        retryDelaysSeconds = @($permanentRetries.delaySeconds)
    }

    if ($Scheduler) {
        $scheduled = New-Fixture 'task-retry'
        $cases += $scheduled
        $null = New-Item -ItemType File -Path "$($scheduled.path)\fail-resolver"
        $taskName = 'HAPI Native Recovery Validation ' + [Guid]::NewGuid().ToString('N')
        $launcher = Join-Path $env:LOCALAPPDATA 'HAPI\hidden-task-launcher\HiddenTaskLauncher.exe'
        # Isolate the scheduler's own policy from the production wrapper retries.
        @'
$config = Get-Content -LiteralPath "$PSScriptRoot\config.json" -Raw | ConvertFrom-Json
& $config.nodeExe "$PSScriptRoot\supervisor.mjs"
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath "$($scheduled.path)\run-once.ps1" -Encoding ASCII
        $action = New-ScheduledTaskAction -Execute $launcher -Argument (
            '"{0}\run-once.ps1" "{0}" Bypass' -f $scheduled.path
        ) -WorkingDirectory $scheduled.path
        $principal = New-ScheduledTaskPrincipal -UserId $owner.Name -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
        $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(12))
        $registered = Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Trigger $trigger
        $validationTask = $taskName
        $evidence.results.scheduledRetry = [ordered]@{
            trigger = 'one-time scheduled trigger'
            restartCount = $registered.Settings.RestartCount
            restartInterval = $registered.Settings.RestartInterval
            automaticRetryObserved = $false
        }
        $failureInfo = Wait-Result {
            $info = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $validationTask
            if ($info.LastTaskResult -eq 1 -and (Read-State $scheduled.path 'stopped').reason -eq 'startup-failed') { $info }
        } 35 'Task Scheduler did not record exit code one from the hidden action.'
        $evidence.results.scheduledRetry.failedActionExitCode = $failureInfo.LastTaskResult
        $evidence.results.scheduledRetry.failedRunAt = $failureInfo.LastRunTime.ToUniversalTime().ToString('o')
        Remove-Item -LiteralPath "$($scheduled.path)\fail-resolver"
        try {
            $recovered = Wait-Result {
                $state = Read-State $scheduled.path 'managed'
                $info = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $validationTask
                if ($state.status -eq 'ready' -and $state.daemonReady -and $info.LastRunTime -gt $failureInfo.LastRunTime) { $state }
            } 100 'Task Scheduler did not retry the failed action.'
        } catch {
            $lastInfo = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $validationTask
            $evidence.results.scheduledRetry.lastObservedRunAt = $lastInfo.LastRunTime.ToUniversalTime().ToString('o')
            $evidence.results.scheduledRetry.lastObservedResult = $lastInfo.LastTaskResult
            throw
        }
        Assert-OwnedDaemon $recovered $scheduled
        $recoveryInfo = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $validationTask
        $evidence.results.scheduledRetry.automaticRetryObserved = $true
        $evidence.results.scheduledRetry.automaticRetryAt = $recoveryInfo.LastRunTime.ToUniversalTime().ToString('o')
        $evidence.results.scheduledRetry.recoveredDaemonPid = $recovered.daemon.pid
        $null = New-Item -ItemType File -Path "$($scheduled.path)\state\stop"
        $successInfo = Wait-Result {
            $info = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $validationTask
            if ($info.LastTaskResult -eq 0 -and (Read-State $scheduled.path 'stopped').reason -eq 'requested') { $info }
        } 20 'Task Scheduler did not record exit code zero after the requested stop.'
        Assert-RequestedStop $scheduled
        $evidence.results.scheduledRetry.requestedStopExitCode = $successInfo.LastTaskResult
    }
    $evidence.passed = $true
} catch {
    $evidence.error = $_.Exception.Message
    throw
} finally {
    try {
        foreach ($case in $cases) { Stop-Fixture $case }
        if ($validationTask) {
            Stop-ScheduledTask -TaskPath '\' -TaskName $validationTask -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskPath '\' -TaskName $validationTask -Confirm:$false
            $evidence.validationTaskRemoved = !(Get-ScheduledTask -TaskPath '\' -TaskName $validationTask -ErrorAction SilentlyContinue)
        }
        Remove-FixtureTree
        $evidence.fixtureRemoved = $true
    } catch {
        $evidence.fixtureRemoved = $false
        $evidence.fixturePath = $testRoot
        $evidence.cleanupError = $_.Exception.Message
        throw
    } finally {
        $evidence | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $PSScriptRoot $evidenceName) -Encoding UTF8
    }
}
