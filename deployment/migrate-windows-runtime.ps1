[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OldRoot,
    [Parameter(Mandatory)][string]$NewRoot,
    [Parameter(Mandatory)][string]$ReceiptDirectory,
    [string]$WorkspaceRoot = (Join-Path $env:USERPROFILE 'codex-temp'),
    [switch]$Migrate
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ownerSid = $identity.User.Value
$receiptName = 'windows-runtime-migration.json'
$receipt = [ordered]@{ startedUtc = [DateTime]::UtcNow.ToString('o'); stage = 'preflight'; status = 'running' }

function Assert-SafePath([string]$Path) {
    if ($Path -notmatch '^[a-zA-Z]:\\' -or [IO.Path]::GetFullPath($Path) -ne $Path -or $Path.Contains('"')) {
        throw 'INVALID_ABSOLUTE_PATH'
    }
    for ($current = $Path; $current; $current = Split-Path -Parent $current) {
        if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'REPARSE_POINT_IN_PATH'
        }
    }
}

function Write-Receipt {
    $json = $receipt | ConvertTo-Json -Depth 4
    foreach ($directory in @($ReceiptDirectory, $NewRoot)) {
        if ($directory -eq $NewRoot -and !$createdRoot) { continue }
        $path = Join-Path $directory $receiptName
        Assert-SafePath $path
        $temporary = "$path.$PID.tmp"
        Assert-SafePath $temporary
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            [IO.File]::Replace($temporary, $path, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $path)
        }
    }
}

function Get-Failure($Record) {
    if ($Record.Exception.Message -cmatch '^[A-Z][A-Z0-9_]+$') { return $Record.Exception.Message }
    return "$($Record.Exception.GetType().Name) ($($Record.Exception.HResult))"
}

function Copy-RuntimeItem([string]$Source, [string]$Destination, [string[]]$Skip = @(), [string]$ContentSource = $Source) {
    if (!$Source.StartsWith("$OldRoot\", [StringComparison]::OrdinalIgnoreCase) -or
        !$ContentSource.StartsWith("$OldRoot\", [StringComparison]::OrdinalIgnoreCase) -or
        !$Destination.StartsWith("$NewRoot\", [StringComparison]::OrdinalIgnoreCase)) { throw 'COPY_OUTSIDE_RUNTIME_ROOTS' }
    Assert-SafePath $Source
    Assert-SafePath $Destination
    Assert-SafePath $ContentSource
    $item = Get-Item -LiteralPath $Source -Force
    if ($item.PSIsContainer) {
        [IO.Directory]::CreateDirectory($Destination) | Out-Null
        foreach ($child in Get-ChildItem -LiteralPath $Source -Force) {
            if ($child.Name -notin $Skip) { Copy-RuntimeItem $child.FullName (Join-Path $Destination $child.Name) }
        }
        return
    }
    # New files inherit the protected runtime root's current-user/System ACL.
    # Copy data without trying to restore unrelated source owners or audit ACLs.
    ([IO.File]::Open($Destination, [IO.FileMode]::CreateNew)).Dispose()
    $payload = Get-Item -LiteralPath $ContentSource -Force
    $inputFile = [IO.File]::Open($ContentSource, 'Open', 'Read', 'ReadWrite, Delete')
    try {
        $outputFile = [IO.File]::Open($Destination, 'Open', 'Write', 'None')
        try { $inputFile.CopyTo($outputFile) } finally { $outputFile.Dispose() }
    } finally { $inputFile.Dispose() }
    [IO.File]::SetLastWriteTimeUtc($Destination, $payload.LastWriteTimeUtc)
    if ((Get-Item -LiteralPath $Destination).Length -ne $payload.Length) { throw 'COPIED_LENGTH_MISMATCH' }
}

function Read-State([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    Assert-SafePath $Path
    try { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return }
}

function Test-Owner($Process) {
    if (!$Process) { return $false }
    $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    return $owner.ReturnValue -eq 0 -and $owner.Sid -eq $ownerSid
}

function Get-OwnedTaskProcesses($Spec, [string]$Root) {
    $action = if ($Root -eq $OldRoot) { $Spec.oldAction } else { $Spec.newAction }
    $entry = Join-Path $Root $Spec.entry
    $processes = @(Get-CimInstance Win32_Process)
    $launchers = @($processes | Where-Object {
        $_.ExecutablePath -eq $action.Execute -and $_.CommandLine -and
        $_.CommandLine.TrimEnd().EndsWith(" $($action.Arguments)", [StringComparison]::OrdinalIgnoreCase) -and (Test-Owner $_)
    })
    if ($launchers.Count -eq 0) { return @{} }
    if ($launchers.Count -ne 1) { throw 'AMBIGUOUS_TASK_LAUNCHER' }
    $launcher = $launchers[0]
    $shell = @($processes | Where-Object {
        $_.ParentProcessId -eq $launcher.ProcessId -and $_.CreationDate -ge $launcher.CreationDate -and
        $_.ExecutablePath -eq $powershell -and $_.CommandLine -match (' -File "' + [regex]::Escape($entry) + '"\s*$') -and (Test-Owner $_)
    })
    if ($shell.Count -gt 1) { throw 'AMBIGUOUS_TASK_POWERSHELL' }
    $executable = if ($Spec.kind -eq 'runner') { Join-Path $Root 'package\bin\hapi.exe' } else { $nativeRuntime.nodeExe }
    $arguments = if ($Spec.kind -eq 'runner') { ' runner start-sync(?: |$)' } else { ' "' + [regex]::Escape((Join-Path $Root 'windows-native\supervisor.mjs')) + '"\s*$' }
    $worker = @($processes | Where-Object {
        $shell.Count -eq 1 -and $_.ParentProcessId -eq $shell[0].ProcessId -and $_.CreationDate -ge $shell[0].CreationDate -and
        $_.ExecutablePath -eq $executable -and $_.CommandLine -match $arguments -and (Test-Owner $_)
    })
    if ($worker.Count -gt 1) { throw 'AMBIGUOUS_TASK_WORKER' }
    $children = @($processes | Where-Object {
        $Spec.kind -eq 'native' -and $worker.Count -eq 1 -and $_.ParentProcessId -eq $worker[0].ProcessId -and
        $_.CreationDate -ge $worker[0].CreationDate -and ($_.ExecutablePath -in @($nativeRuntime.cliExe, $nativeRuntime.desktopExe)) -and (Test-Owner $_)
    })
    return @{ launcher = $launcher; shell = $shell | Select-Object -First 1; worker = $worker | Select-Object -First 1; children = $children }
}

function Get-SameProcess($Expected) {
    if (!$Expected) { return }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($Expected.ProcessId)"
    if ($current -and $current.CreationDate -eq $Expected.CreationDate -and $current.ExecutablePath -eq $Expected.ExecutablePath -and (Test-Owner $current)) { return $current }
}

function Stop-OwnedProcess($Expected) {
    if (!(Get-SameProcess $Expected)) { return }
    $process = Get-Process -Id $Expected.ProcessId -ErrorAction SilentlyContinue
    if (!$process) { return }
    try {
        # Hold the native process handle while rechecking the CIM identity.
        $null = $process.Handle
        if ((Get-SameProcess $Expected) -and !$process.HasExited) { $process.Kill() }
        if (!$process.WaitForExit(5000)) { throw 'OWNED_PROCESS_STOP_TIMEOUT' }
    } finally { $process.Dispose() }
}

function Test-Listener([int]$Port, [int]$ProcessId) {
    if ($Port -lt 1 -or $Port -gt 65535) { return $false }
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return @($listener | Where-Object OwningProcess -eq $ProcessId).Count -eq 1
}

function Invoke-RunnerControl([int]$Port, [string]$Operation) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/$Operation")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 3000
    $request.Method = 'POST'
    $request.ContentType = 'application/json'
    $request.ContentLength = 2
    $stream = $request.GetRequestStream()
    try { $stream.Write([byte[]]@(123, 125), 0, 2) } finally { $stream.Dispose() }
    $response = $request.GetResponse()
    try { return [int]$response.StatusCode -eq 200 } finally { $response.Dispose() }
}

function Get-ManagedProcess($Recorded) {
    if (!$Recorded -or $Recorded.ownerSid -ne $ownerSid -or [int]$Recorded.pid -lt 1) { return }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Recorded.pid)"
    if ($process -and $process.ExecutablePath -eq $Recorded.executable -and
        $process.CreationDate.ToUniversalTime() -eq ([DateTimeOffset]$Recorded.started).UtcDateTime -and (Test-Owner $process)) { return $process }
}

function Get-RecordedRuntimeProcesses([string]$Root) {
    $runnerState = Read-State (Join-Path $Root 'windows-state\runner.state.json')
    $runner = if ([int]$runnerState.pid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$runnerState.pid)" }
    if ($runner.ExecutablePath -ne (Join-Path $Root 'package\bin\hapi.exe') -or
        $runner.CommandLine -notmatch ' runner start-sync(?: |$)' -or !(Test-Owner $runner)) { $runner = $null }
    $state = Read-State (Join-Path $Root 'windows-native\state\managed.json')
    $supervisor = Get-ManagedProcess $state.supervisor
    $entry = [regex]::Escape((Join-Path $Root 'windows-native\supervisor.mjs'))
    if ($supervisor.ExecutablePath -ne $nativeRuntime.nodeExe -or $supervisor.CommandLine -notmatch (' "' + $entry + '"\s*$')) { $supervisor = $null }
    $children = if ($supervisor) {
        @((Get-ManagedProcess $state.daemon), (Get-ManagedProcess $state.desktop)) | Where-Object {
            $_ -and $_.ParentProcessId -eq $supervisor.ProcessId -and $_.CreationDate -ge $supervisor.CreationDate
        }
    }
    return @{ runner = @{worker = $runner}; native = @{worker = $supervisor; children = $children} }
}

function Get-ReadinessFailure([string]$Root, [datetime]$After, $Recorded) {
    $runnerTree = if ($Recorded) { $Recorded.runner } else { Get-OwnedTaskProcesses $runnerSpec $Root }
    if (!$runnerTree.worker -or $runnerTree.worker.CreationDate.ToUniversalTime() -lt $After) { return 'RUNNER_TASK_PROCESS' }
    $runnerState = Read-State (Join-Path $Root 'windows-state\runner.state.json')
    if ($runnerState.pid -ne $runnerTree.worker.ProcessId -or !(Test-Listener $runnerState.httpPort $runnerTree.worker.ProcessId)) { return 'RUNNER_LISTENER' }
    try { if (!(Invoke-RunnerControl $runnerState.httpPort 'list')) { return 'RUNNER_CONTROL' } } catch { return 'RUNNER_CONTROL' }
    $nativeTree = if ($Recorded) { $Recorded.native } else { Get-OwnedTaskProcesses $nativeSpec $Root }
    if (!$nativeTree.worker -or $nativeTree.worker.CreationDate.ToUniversalTime() -lt $After) { return 'NATIVE_TASK_PROCESS' }
    $nativeState = Read-State (Join-Path $Root 'windows-native\state\managed.json')
    if (!$nativeState.daemonReady -or !$nativeState.toolsPipeReady -or !$nativeState.desktopBackendConnected -or $nativeState.url -ne $nativeConfig.websocketUrl) { return 'NATIVE_MANAGED_STATE' }
    $supervisor = Get-ManagedProcess $nativeState.supervisor
    $daemon = Get-ManagedProcess $nativeState.daemon
    $desktop = Get-ManagedProcess $nativeState.desktop
    if (!$supervisor -or $supervisor.ProcessId -ne $nativeTree.worker.ProcessId -or !$daemon -or !$desktop -or
        $daemon.ParentProcessId -ne $supervisor.ProcessId) { return 'NATIVE_MANAGED_PROCESS' }
    if (!(Test-Listener ([uri]$nativeConfig.websocketUrl).Port $daemon.ProcessId)) { return 'NATIVE_LISTENER' }
}

function Stop-Runner($Tree, [string]$Root) {
    $worker = $Tree.worker
    if (!(Get-SameProcess $worker)) { return }
    $state = Read-State (Join-Path $Root 'windows-state\runner.state.json')
    if ($state.pid -eq $worker.ProcessId -and (Test-Listener $state.httpPort $worker.ProcessId)) {
        try { $null = Invoke-RunnerControl $state.httpPort 'stop' } catch {}
    }
    $until = [DateTime]::UtcNow.AddSeconds(5)
    while ((Get-SameProcess $worker) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 250 }
    Stop-OwnedProcess $worker
}

function Stop-Native($Tree, [string]$Root) {
    if (Get-SameProcess $Tree.worker) {
        $marker = Join-Path $Root 'windows-native\state\stop'
        Assert-SafePath $marker
        [IO.File]::WriteAllText($marker, '')
        $until = [DateTime]::UtcNow.AddSeconds(30)
        while ((Get-SameProcess $Tree.worker) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 500 }
    }
    Stop-OwnedProcess $Tree.worker
    foreach ($child in $Tree.children) { Stop-OwnedProcess $child }
}

function Clear-VolatileState([string]$Root) {
    if ($Root -notin @($OldRoot, $NewRoot)) { throw 'INVALID_STATE_ROOT' }
    foreach ($relative in @('windows-native\state\stop', 'windows-native\state\open', 'windows-native\state\managed.json',
            'windows-native\state\managed.json.tmp', 'windows-native\state\stopped.json',
            'windows-state\runner.state.json', 'windows-state\runner.state.json.lock')) {
        $file = Join-Path $Root $relative
        Assert-SafePath $file
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
    }
}

function Set-TaskActions([bool]$Restore) {
    foreach ($spec in $specs) {
        $action = if ($Restore) { $spec.oldAction } else { $spec.newAction }
        Set-ScheduledTask -TaskName $spec.name -TaskPath '\' -Action $action | Out-Null
    }
}

function Stop-Tasks {
    foreach ($spec in $specs) {
        Disable-ScheduledTask -TaskName $spec.name -TaskPath '\' | Out-Null
        if ($taskFolder.GetTask($spec.name).GetInstances(0).Count -gt 0) {
            try { Stop-ScheduledTask -TaskName $spec.name -TaskPath '\' } catch {
                if ($taskFolder.GetTask($spec.name).GetInstances(0).Count -gt 0) { throw }
            }
        }
    }
    foreach ($spec in $specs) {
        $until = [DateTime]::UtcNow.AddSeconds(15)
        while ($taskFolder.GetTask($spec.name).GetInstances(0).Count -gt 0) {
            if ([DateTime]::UtcNow -ge $until) { throw 'SCHEDULED_TASK_STOP_TIMEOUT' }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Start-Tasks {
    foreach ($spec in $specs) {
        Enable-ScheduledTask -TaskName $spec.name -TaskPath '\' | Out-Null
        Start-ScheduledTask -TaskName $spec.name -TaskPath '\'
    }
}

function Wait-Ready([string]$Root, [datetime]$After) {
    $until = [DateTime]::UtcNow.AddSeconds(100)
    do {
        $failure = Get-ReadinessFailure $Root $After
        if (!$failure) { return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $until)
    throw "RUNTIME_READINESS_TIMEOUT_$failure"
}

$createdRoot = $false
$tasksChanged = $false
$newStartAttempted = $false
$oldStopAttempted = $false
$pathsValidated = $false
try {
    foreach ($path in @($OldRoot, $NewRoot, $WorkspaceRoot, $ReceiptDirectory, $PSScriptRoot)) { Assert-SafePath $path }
    if ($OldRoot -ne (Join-Path $WorkspaceRoot 'hapi-deployment') -or $NewRoot -ne (Join-Path $env:LOCALAPPDATA 'HAPI') -or
        $WorkspaceRoot -ne (Join-Path $env:USERPROFILE 'codex-temp') -or
        !$ReceiptDirectory.StartsWith("$OldRoot\", [StringComparison]::OrdinalIgnoreCase) -or
        !(Test-Path -LiteralPath $ReceiptDirectory -PathType Container)) { throw 'UNEXPECTED_RUNTIME_LAYOUT' }
    $pathsValidated = $true
    if (Test-Path -LiteralPath $NewRoot) { throw 'DESTINATION_ALREADY_EXISTS' }
    if ($PSScriptRoot -ne (Join-Path $OldRoot 'ops\deployment')) { throw 'UNEXPECTED_SCRIPT_LOCATION' }
    $runnerEntry = Join-Path $PSScriptRoot 'start-windows-runner.ps1'
    $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    foreach ($file in @($runnerEntry, "$OldRoot\start-windows-runner.ps1", "$OldRoot\package\bin\hapi.exe",
        "$OldRoot\hidden-task-launcher\HiddenTaskLauncher.exe", "$OldRoot\windows-native\run.ps1",
        "$OldRoot\windows-native\config.json", "$OldRoot\windows-native\supervisor.mjs", "$OldRoot\windows-native\resolve-runtime.ps1")) {
        Assert-SafePath $file
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'MISSING_RUNTIME_FILE' }
    }
    $nativeConfig = Read-State "$OldRoot\windows-native\config.json"
    $nativeName = "HAPI Codex Native $ownerSid"
    if ($nativeConfig.ownerSid -ne $ownerSid -or $nativeConfig.taskName -ne $nativeName) { throw 'UNEXPECTED_NATIVE_CONFIG_OWNER' }
    $nativeRuntime = & "$OldRoot\windows-native\resolve-runtime.ps1" -Config "$OldRoot\windows-native\config.json" | ConvertFrom-Json
    $nativeRuntime.nodeExe = [IO.Path]::GetFullPath($nativeRuntime.nodeExe)
    $runnerSpec = @{ kind = 'runner'; name = 'HAPI-Windows-Runner'; entry = 'start-windows-runner.ps1'; oldDirectory = $WorkspaceRoot; newDirectory = $WorkspaceRoot; suffix = '' }
    $nativeSpec = @{ kind = 'native'; name = $nativeName; entry = 'windows-native\run.ps1'; oldDirectory = "$OldRoot\windows-native"; newDirectory = "$NewRoot\windows-native"; suffix = ' Bypass' }
    $specs = @($runnerSpec, $nativeSpec)
    foreach ($spec in $specs) {
        $task = Get-ScheduledTask -TaskName $spec.name -TaskPath '\'
        $principal = if ($task.Principal.UserId -like 'S-1-*') { $task.Principal.UserId } else {
            [Security.Principal.NTAccount]::new($task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        $existingAction = $task.Actions | Select-Object -First 1
        $expectedArguments = '"{0}\{1}" "{2}"{3}' -f $OldRoot, $spec.entry, $spec.oldDirectory, $spec.suffix
        if ($task.State -ne 'Running' -or $principal -ne $ownerSid -or $task.Actions.Count -ne 1 -or
            $existingAction.Execute -ne "$OldRoot\hidden-task-launcher\HiddenTaskLauncher.exe" -or
            $existingAction.Arguments -ne $expectedArguments -or $existingAction.WorkingDirectory -ne $spec.oldDirectory) { throw 'UNEXPECTED_TASK_DEFINITION' }
        $spec.oldAction = $existingAction
        $actionParameters = @{
            Execute = "$NewRoot\hidden-task-launcher\HiddenTaskLauncher.exe"
            Argument = '"{0}\{1}" "{2}"{3}' -f $NewRoot, $spec.entry, $spec.newDirectory, $spec.suffix
            WorkingDirectory = $spec.newDirectory
        }
        if ($existingAction.Id) { $actionParameters.Id = $existingAction.Id }
        $spec.newAction = New-ScheduledTaskAction @actionParameters
    }
    $taskService = New-Object -ComObject 'Schedule.Service'
    $taskService.Connect()
    $taskFolder = $taskService.GetFolder('\')
    $oldProcesses = Get-RecordedRuntimeProcesses $OldRoot
    $failure = Get-ReadinessFailure $OldRoot ([DateTime]::MinValue) $oldProcesses
    if ($failure) { throw "OLD_RUNTIME_NOT_READY_$failure" }
    if (!$Migrate) {
        $receipt.status = 'preflight-passed'
        $receipt | ConvertTo-Json
        return
    }

    $receipt.stage = 'copy-static-files'
    # The protected root is set before putting any runtime data beneath it.
    $private = [Security.AccessControl.DirectorySecurity]::new()
    $private.SetSecurityDescriptorSddlForm("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;$ownerSid)")
    Assert-SafePath $NewRoot
    if (Test-Path -LiteralPath $NewRoot) { throw 'DESTINATION_ALREADY_EXISTS' }
    [IO.Directory]::CreateDirectory($NewRoot, $private) | Out-Null
    $createdRoot = $true
    Write-Receipt
    Copy-RuntimeItem "$OldRoot\package" "$NewRoot\package"
    Copy-RuntimeItem "$OldRoot\hidden-task-launcher" "$NewRoot\hidden-task-launcher"
    Copy-RuntimeItem "$OldRoot\windows-native" "$NewRoot\windows-native" @('state')
    [IO.Directory]::CreateDirectory("$NewRoot\windows-state") | Out-Null
    if (Test-Path -LiteralPath "$OldRoot\windows-state\runtime" -PathType Container) {
        Copy-RuntimeItem "$OldRoot\windows-state\runtime" "$NewRoot\windows-state\runtime"
    }
    $newRunner = Join-Path $NewRoot $runnerSpec.entry
    Copy-RuntimeItem "$OldRoot\start-windows-runner.ps1" $newRunner -ContentSource $runnerEntry
    if ((Get-FileHash -LiteralPath $runnerEntry).Hash -ne (Get-FileHash -LiteralPath $newRunner).Hash) { throw 'COPIED_HASH_MISMATCH' }
    foreach ($relative in @('package\bin\hapi.exe', 'hidden-task-launcher\HiddenTaskLauncher.exe', 'windows-native\run.ps1',
            'windows-native\config.json', 'windows-native\supervisor.mjs')) {
        if ((Get-FileHash -LiteralPath "$OldRoot\$relative").Hash -ne (Get-FileHash -LiteralPath "$NewRoot\$relative").Hash) { throw 'COPIED_HASH_MISMATCH' }
    }

    $receipt.stage = 'stop-old-runtime'
    Write-Receipt
    $oldProcesses = Get-RecordedRuntimeProcesses $OldRoot
    $failure = Get-ReadinessFailure $OldRoot ([DateTime]::MinValue) $oldProcesses
    if ($failure) { throw "OLD_RUNTIME_CHANGED_DURING_COPY_$failure" }
    $tasksChanged = $true
    $oldStopAttempted = $true
    Stop-Tasks
    Stop-Runner $oldProcesses.runner $OldRoot
    Stop-Native $oldProcesses.native $OldRoot

    $receipt.stage = 'copy-state-and-switch-tasks'
    Write-Receipt
    Copy-RuntimeItem "$OldRoot\windows-state" "$NewRoot\windows-state" @('runtime', 'runner.state.json', 'runner.state.json.lock')
    Copy-RuntimeItem "$OldRoot\windows-native\state" "$NewRoot\windows-native\state" @('stop', 'open', 'managed.json', 'managed.json.tmp', 'stopped.json')
    if (Test-Path -LiteralPath "$OldRoot\windows-runner.log" -PathType Leaf) { Copy-RuntimeItem "$OldRoot\windows-runner.log" "$NewRoot\windows-runner.log" }
    Set-TaskActions $false
    $newStartAttempted = $true
    $after = [DateTime]::UtcNow
    Start-Tasks
    $receipt.stage = 'wait-for-new-runtime'
    Write-Receipt
    Wait-Ready $NewRoot $after
    $receipt.status = 'migrated'
    $receipt.activeRoot = $NewRoot
} catch {
    $receipt.status = 'failed'
    $receipt.failure = Get-Failure $_
    $receipt.failureLine = $_.InvocationInfo.ScriptLineNumber
    if ($tasksChanged) {
        try {
            if ($newStartAttempted) {
                $newRunnerTree = Get-OwnedTaskProcesses $runnerSpec $NewRoot
                $newNativeTree = Get-OwnedTaskProcesses $nativeSpec $NewRoot
            }
            Stop-Tasks
            if ($newStartAttempted) {
                Stop-Runner $newRunnerTree $NewRoot
                Stop-Native $newNativeTree $NewRoot
            }
            if ($oldStopAttempted) {
                Stop-Runner $oldProcesses.runner $OldRoot
                Stop-Native $oldProcesses.native $OldRoot
                Clear-VolatileState $OldRoot
            }
            Set-TaskActions $true
            Start-Tasks
            Wait-Ready $OldRoot ([DateTime]::MinValue)
            $receipt.status = 'rolled-back'
            $receipt.activeRoot = $OldRoot
        } catch {
            $receipt.status = 'rollback-failed'
            $receipt.rollbackFailure = Get-Failure $_
        }
    }
} finally {
    if ($Migrate -and $pathsValidated) {
        $receipt.finishedUtc = [DateTime]::UtcNow.ToString('o')
        Write-Receipt
    }
}

if ($receipt.status -ne 'migrated') { throw "Windows runtime migration $($receipt.status) at $($receipt.stage) [$($receipt.failure)]." }
