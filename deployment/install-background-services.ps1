[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'HAPI'),
    [string]$WorkspaceRoot = (Join-Path $env:USERPROFILE 'codex-temp'),
    [switch]$WslOnly,
    [switch]$ServicesOnly,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$includeNative = !$WslOnly -and !$ServicesOnly
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ownerSid = $identity.User.Value
if (!([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the installer from an independent elevated PowerShell as the deployment owner.'
}
$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).ProviderPath
if (!$WslOnly) { $WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).ProviderPath }
$nativeRoot = Join-Path $RuntimeRoot 'windows-native'
$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$scriptHost = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
$wsl = Join-Path ([Environment]::SystemDirectory) 'wsl.exe'
$hapi = Join-Path $RuntimeRoot 'package\bin\hapi.exe'
$launcher = Join-Path $RuntimeRoot 'task-launcher.ps1'
$receiptDirectory = Join-Path $RuntimeRoot 'background-services'
$wslUnits = @('hapi-hub', 'hapi-runner', 'dsh-web', 'mobile-editor', 'remote-portal', 'seia-auth', 'termix', 'desktop-commander', 'seia-codex-daemon')
$wslSpec = @{ name = 'Seia-WSL-Services'; entry = 'start-wsl-services.ps1'; directory = $RuntimeRoot; worker = $wsl; workerArgs = ' /bin/(?:sleep infinity|cat)\s*$'; interactive = $true }
$runnerSpec = @{ name = 'HAPI-Windows-Runner'; entry = 'start-windows-runner.ps1'; directory = $WorkspaceRoot; worker = $hapi; workerArgs = ' runner start-sync(?: |$)'; interactive = $true }
$nativeSpec = @{ name = "HAPI Codex Native $ownerSid"; entry = 'windows-native\run.ps1'; directory = $nativeRoot; interactive = $true }
$desktopSpec = @{ name = "HAPI Codex Desktop $ownerSid"; entry = 'windows-native\desktop.ps1'; directory = $nativeRoot; interactive = $true }
$services = if ($WslOnly) { @($wslSpec) } else { @($wslSpec, $runnerSpec) }
$tasks = if ($includeNative) { @($wslSpec, $runnerSpec, $nativeSpec, $desktopSpec) } else { $services }
$receipt = [ordered]@{ startedUtc = [DateTime]::UtcNow.ToString('o'); status = 'running'; stage = 'preflight'; ownerSid = $ownerSid; tasks = [ordered]@{} }
$recoveryErrors = [Collections.Generic.List[string]]::new()

function Read-Json([string]$Path, [switch]$Required) {
    try { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { if ($Required) { throw "Cannot read $(Split-Path -Leaf $Path)." } }
}

function Get-Task($Spec) {
    Get-ScheduledTask -TaskName $Spec.name -TaskPath '\' -ErrorAction SilentlyContinue
}

function Write-Receipt {
    $receiptPath = Join-Path $receiptDirectory 'install-result.json'
    $temp = "$receiptPath.$PID.tmp"
    [IO.File]::WriteAllText($temp, ($receipt | ConvertTo-Json -Depth 8))
    if ([IO.File]::Exists($receiptPath)) { [IO.File]::Replace($temp, $receiptPath, [NullString]::Value) }
    else { [IO.File]::Move($temp, $receiptPath) }
}

function New-TaskXml($Spec) {
    $definition = $taskService.NewTask(0)
    $definition.Principal.UserId = $ownerSid
    $definition.Principal.RunLevel = 0 # Least privilege
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.StartWhenAvailable = $true
    $definition.Settings.MultipleInstances = 2 # IgnoreNew
    if ($Spec.interactive) {
        $definition.Principal.LogonType = 3 # Interactive token
        $trigger = $definition.Triggers.Create(9) # Logon
        $trigger.UserId = $ownerSid
    } else {
        $definition.Principal.LogonType = 2 # S4U
        $null = $definition.Triggers.Create(8) # Boot
    }
    if ($Spec -ne $desktopSpec) {
        $definition.Settings.RestartInterval = 'PT1M'
        $definition.Settings.RestartCount = 3
    }
    $action = $definition.Actions.Create(0) # Exec
    $action.Path = $scriptHost
    $action.Arguments = '//B //NoLogo "{0}" "{1}" "{2}"' -f
        (Join-Path $RuntimeRoot 'task-bootstrap.js'), (Join-Path $RuntimeRoot $Spec.entry), ($Spec.directory -replace '(\\+)$', '$1$1')
    $action.WorkingDirectory = $Spec.directory
    $null = $taskFolder.RegisterTaskDefinition($Spec.name, $definition, 1, $ownerSid, $null, [int]$definition.Principal.LogonType, $null)
    $definition.XmlText
}

function Save-Task($Spec) {
    $task = Get-Task $Spec
    if (!$task) {
        if ($Spec -eq $nativeSpec -or $Spec -eq $runnerSpec) { throw "Required task is missing: $($Spec.name)." }
        return
    }
    $principal = $task.Principal.UserId
    if ($principal -notlike 'S-1-*') {
        $principal = [Security.Principal.NTAccount]::new($principal).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    $entry = [regex]::Escape((Join-Path $RuntimeRoot $Spec.entry))
    $oldLauncher = Join-Path $RuntimeRoot 'hidden-task-launcher\HiddenTaskLauncher.exe'
    $versionedLauncher = Join-Path $RuntimeRoot 'hidden-task-launcher\HiddenTaskLauncher-v2.exe'
    if ($principal -ne $ownerSid -or $task.Principal.LogonType -notin @('Interactive', 'S4U') -or
        $task.Principal.RunLevel -ne 'Limited' -or $task.Actions.Count -ne 1 -or
        $task.Actions[0].Execute -notin @($powershell, $scriptHost, $oldLauncher, $versionedLauncher) -or
        $task.Actions[0].Arguments -notmatch ('(?:^|\s)"' + $entry + '"(?:\s|$)')) {
        throw "Unexpected existing task definition: $($Spec.name)."
    }
    $Spec.oldXml = Join-Path $staging ($Spec.entry.Replace('\', '-') + '.before.xml')
    $registered = $taskFolder.GetTask($Spec.name)
    $Spec.wasRunning = $registered.GetInstances(0).Count -gt 0
    $Spec.wasEnabled = [bool]$registered.Enabled
    $Spec.oldLogonType = [string]$task.Principal.LogonType
    $registered.Xml | Set-Content -LiteralPath $Spec.oldXml -Encoding Unicode
}

function Test-Owner($Process) {
    if (!$Process) { return $false }
    $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    return $owner.ReturnValue -eq 0 -and $owner.Sid -eq $ownerSid
}

function Get-Wrappers($Spec, $Processes) {
    $entry = [regex]::Escape((Join-Path $RuntimeRoot $Spec.entry))
    $Processes | Where-Object { $_.ExecutablePath -eq $powershell -and
        $_.CommandLine -match (' -File (?:"' + $entry + '"|' + $entry + ')\s*$') -and (Test-Owner $_) }
}

function Get-Workers($Spec, $Wrappers, $Processes) {
    foreach ($wrapper in $Wrappers) {
        $Processes | Where-Object { $_.ParentProcessId -eq $wrapper.ProcessId -and $_.CreationDate -ge $wrapper.CreationDate -and
            $_.ExecutablePath -eq $Spec.worker -and $_.CommandLine -match $Spec.workerArgs -and (Test-Owner $_) }
    }
}

function Get-SameProcess($Expected) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($Expected.ProcessId)"
    if ($current -and $current.CreationDate -eq $Expected.CreationDate -and $current.ExecutablePath -eq $Expected.ExecutablePath -and
        $current.CommandLine -eq $Expected.CommandLine -and (Test-Owner $current)) { $current }
}

function Stop-VerifiedProcess($Expected) {
    $process = Get-Process -Id $Expected.ProcessId -ErrorAction SilentlyContinue
    if (!$process) { return }
    try {
        try { $null = $process.Handle } catch { if ($process.HasExited) { return }; throw }
        if (!(Get-SameProcess $Expected) -or $process.HasExited) { return }
        try { $process.Kill() } catch { if (!$process.HasExited) { throw } }
        if (!$process.WaitForExit(5000)) { throw "Process $($Expected.ProcessId) did not exit." }
    } finally { $process.Dispose() }
}

function Test-RunnerEndpoint($State, $Worker) {
    $port = [int]$State.httpPort
    if ($State.pid -ne $Worker.ProcessId -or $port -lt 1 -or $port -gt 65535) { return $false }
    # On this Windows build, a live listener can be reported with TCP state 0.
    $rows = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object {
        $_.OwningProcess -eq $Worker.ProcessId -and $_.LocalAddress -eq '127.0.0.1' -and $_.RemotePort -eq 0
    })
    return $rows.Count -gt 0
}

function Invoke-RunnerControl([int]$Port, [string]$Operation) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/$Operation")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 3000
    $request.ReadWriteTimeout = 3000
    $request.Method = 'POST'
    $request.ContentType = 'application/json'
    $request.ContentLength = 2
    $stream = $request.GetRequestStream()
    try { $stream.Write([byte[]]@(123, 125), 0, 2) } finally { $stream.Dispose() }
    $response = $request.GetResponse()
    try { [int]$response.StatusCode -eq 200 } finally { $response.Dispose() }
}

function Stop-TaskInstance($Spec) {
    if (!(Get-Task $Spec)) { return }
    Disable-ScheduledTask -TaskName $Spec.name -TaskPath '\' | Out-Null
    if ($taskFolder.GetTask($Spec.name).GetInstances(0).Count) {
        try { Stop-ScheduledTask -TaskName $Spec.name -TaskPath '\' }
        catch { if ($taskFolder.GetTask($Spec.name).GetInstances(0).Count) { throw } }
    }
    $until = [DateTime]::UtcNow.AddSeconds(15)
    while ($taskFolder.GetTask($Spec.name).GetInstances(0).Count) {
        if ([DateTime]::UtcNow -ge $until) { throw "Task did not stop: $($Spec.name)." }
        Start-Sleep -Milliseconds 250
    }
}

function Stop-ServiceTask($Spec) {
    # The old launcher can exit while its PowerShell retry loop stays alive.
    $before = @(Get-CimInstance Win32_Process)
    $wrappers = @(Get-Wrappers $Spec $before)
    $workers = @(Get-Workers $Spec $wrappers $before)
    Stop-TaskInstance $Spec
    $wrappers = @($wrappers + @(Get-Wrappers $Spec @(Get-CimInstance Win32_Process)) |
        Sort-Object ProcessId, CreationDate -Unique)
    foreach ($wrapper in $wrappers) { Stop-VerifiedProcess $wrapper }
    # The wrapper may have retried between the first snapshot and shutdown.
    $workers = @($workers + @(Get-Workers $Spec $wrappers @(Get-CimInstance Win32_Process)) |
        Sort-Object ProcessId, CreationDate -Unique)
    foreach ($worker in $workers) {
        if ($Spec -eq $runnerSpec -and (Get-SameProcess $worker)) {
            $state = Read-Json "$RuntimeRoot\windows-state\runner.state.json"
            if (Test-RunnerEndpoint $state $worker) {
                try { $null = Invoke-RunnerControl $state.httpPort 'stop' } catch {}
                $until = [DateTime]::UtcNow.AddSeconds(5)
                while ([DateTime]::UtcNow -lt $until -and (Get-SameProcess $worker)) { Start-Sleep -Milliseconds 250 }
            }
        }
        Stop-VerifiedProcess $worker
    }
    $after = @(Get-CimInstance Win32_Process)
    if ((Get-Wrappers $Spec $after) -or (Get-Workers $Spec $wrappers $after)) { throw "Service processes remain: $($Spec.name)." }
}

function Register-TaskXml($Spec, [string]$Path) {
    Register-ScheduledTask -TaskName $Spec.name -TaskPath '\' -Xml (Get-Content -LiteralPath $Path -Raw) -Force | Out-Null
}

function Restore-Task($Spec) {
    if ($Spec.oldXml) {
        Register-TaskXml $Spec $Spec.oldXml
        if (!$Spec.wasEnabled) { Disable-ScheduledTask -TaskName $Spec.name -TaskPath '\' | Out-Null }
        elseif ($Spec.wasRunning) { Start-ScheduledTask -TaskName $Spec.name -TaskPath '\' }
    } elseif (Get-Task $Spec) { Unregister-ScheduledTask -TaskName $Spec.name -TaskPath '\' -Confirm:$false }
}

function Wait-ServiceTasks([datetime]$After, $Pending, [switch]$Restore) {
    $until = [DateTime]::UtcNow.AddSeconds(100)
    while ($Pending.Count) {
        $processes = @(Get-CimInstance Win32_Process)
        $Pending = @(foreach ($spec in $Pending) {
            $interactive = if ($Restore) { $spec.oldLogonType -eq 'Interactive' } else { [bool]$spec.interactive }
            $expectedLogonType = if ($interactive) { 'Interactive' } else { 'S4U' }
            $wrappers = @(Get-Wrappers $spec $processes)
            $workers = @(Get-Workers $spec $wrappers $processes | Where-Object {
                $_.CreationDate.ToUniversalTime() -ge $After -and (($_.SessionId -gt 0) -eq $interactive)
            })
            $ready = $false
            $task = Get-Task $spec
            if ($workers.Count -eq 1 -and $task.State -eq 'Running' -and $task.Principal.LogonType -eq $expectedLogonType) {
                if ($spec -eq $wslSpec) {
                    $active = @(& $wsl --distribution Ubuntu-26.04 --user igna --cd / --exec /usr/bin/timeout 8s /usr/bin/systemctl --user is-active @wslUnits)
                    $ready = $LASTEXITCODE -eq 0 -and $active.Count -eq $wslUnits.Count -and @($active | Where-Object { $_ -ne 'active' }).Count -eq 0
                } else {
                    $state = Read-Json "$RuntimeRoot\windows-state\runner.state.json"
                    if (Test-RunnerEndpoint $state $workers[0]) {
                        try { $ready = Invoke-RunnerControl $state.httpPort 'list' } catch {}
                    }
                }
            }
            if (!$ready) { $spec }
            else { $receipt.tasks[$spec.name].worker = @{ pid = $workers[0].ProcessId; sessionId = $workers[0].SessionId; startedUtc = $workers[0].CreationDate.ToUniversalTime().ToString('o') } }
        })
        if (!$Pending.Count) { return }
        if ([DateTime]::UtcNow -ge $until) { throw ('Service readiness timed out for ' + ($Pending.name -join ', ') + '.') }
        Start-Sleep -Seconds 2
    }
}

function Invoke-Recovery([string]$Name, [scriptblock]$Action) {
    try { & $Action } catch { $recoveryErrors.Add("${Name}: $($_.Exception.Message)") }
}

# The runtime is already private. Keep its transaction lock and all backups here.
New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
$lock = [IO.File]::Open((Join-Path $receiptDirectory 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$staging = Join-Path $receiptDirectory ([Guid]::NewGuid().ToString('N'))
$assets = @(
    @{ entry = 'task-bootstrap.js' }
    @{ entry = 'task-launcher.ps1' }
    @{ entry = 'task-lifetime.ps1' }
) + $services
try {
    New-Item -ItemType Directory -Path $staging | Out-Null
    $taskService = New-Object -ComObject 'Schedule.Service'
    $taskService.Connect()
    $taskFolder = $taskService.GetFolder('\')
    foreach ($spec in $tasks) {
        Save-Task $spec
        $spec.xml = Join-Path $staging ($spec.entry.Replace('\', '-') + '.xml')
        New-TaskXml $spec | Set-Content -LiteralPath $spec.xml -Encoding Unicode
        $receipt.tasks[$spec.name] = [ordered]@{ wasRunning = [bool]$spec.wasRunning; wasEnabled = [bool]$spec.wasEnabled; trigger = $(if ($spec.interactive) { 'Logon' } else { 'Boot' }) }
    }
    foreach ($spec in $assets) {
        $spec.liveScript = Join-Path $RuntimeRoot $spec.entry
        $spec.candidate = Join-Path $staging $spec.entry
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $spec.entry) -Destination $spec.candidate
        if (Test-Path -LiteralPath $spec.liveScript) {
            $spec.unchanged = (Get-FileHash -LiteralPath $spec.liveScript).Hash -eq (Get-FileHash -LiteralPath $spec.candidate).Hash
            if (!$includeNative -and !$spec.worker -and !$spec.unchanged) { throw "Use the full installer to update the shared $($spec.entry) script." }
            $spec.backup = "$($spec.candidate).before"
            Copy-Item -LiteralPath $spec.liveScript -Destination $spec.backup
        }
        if ($spec.worker -and !(Test-Path -LiteralPath $spec.worker -PathType Leaf)) { throw "Worker executable is missing for $($spec.name)." }
    }
    if ($includeNative) {
        $configPath = Join-Path $nativeRoot 'config.json'
        $nativeConfig = Read-Json $configPath -Required
        if ($nativeConfig.ownerSid -ne $ownerSid -or $nativeConfig.taskName -ne $nativeSpec.name -or !$nativeSpec.wasRunning) {
            throw 'The native task must be running under the deployment owner before migration.'
        }
        $oldManaged = Read-Json "$nativeRoot\state\managed.json" -Required
        if (!$oldManaged.supervisor.pid -or !$oldManaged.supervisor.started) { throw 'The previous native supervisor identity is unavailable.' }
        if (Test-Path -LiteralPath "$nativeRoot\state\update-backup") { throw 'Review the previous native update backup before migration.' }
        $nativeRuntime = & "$nativeRoot\resolve-runtime.ps1" -Config $configPath | ConvertFrom-Json
        $nativeConfig | Add-Member -NotePropertyName launchDesktop -NotePropertyValue $false -Force
        $nativeConfig | Add-Member -NotePropertyName desktopTaskName -NotePropertyValue $desktopSpec.name -Force
        $nativeConfig | Add-Member -NotePropertyName desktopExe -NotePropertyValue $nativeRuntime.desktopExe -Force
        $candidateConfig = Join-Path $staging 'native-config.json'
        $nativeConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $candidateConfig -Encoding UTF8
        $nativeCandidate = Join-Path $staging 'windows-native'
        New-Item -ItemType Directory -Path $nativeCandidate | Out-Null
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'windows-native') -File | Where-Object { $_.Extension -in @('.ps1', '.mjs') }) {
            Copy-Item -LiteralPath $file.FullName -Destination $nativeCandidate
        }
        foreach ($file in @('update.ps1', 'run.ps1', 'supervisor.mjs', 'desktop.ps1')) {
            if (!(Test-Path -LiteralPath (Join-Path $nativeCandidate $file) -PathType Leaf)) { throw "Native candidate is missing $file." }
        }
        foreach ($module in Get-ChildItem -LiteralPath $nativeCandidate -File -Filter '*.mjs') {
            & $nativeRuntime.nodeExe --check $module.FullName
            if ($LASTEXITCODE) { throw "Cannot parse $($module.Name)." }
        }
    }
    foreach ($scriptFile in Get-ChildItem -LiteralPath $staging -Filter '*.ps1' -File -Recurse) {
        $tokens = $null
        $parseErrors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile($scriptFile.FullName, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count) { throw "Cannot parse $($scriptFile.Name): $($parseErrors[0].Message)" }
    }
    if ($ValidateOnly) { $receipt.status = 'validated'; $receipt | ConvertTo-Json -Depth 8; return }

    $receipt.stage = 'switch-wsl-and-runner'
    Write-Receipt
    foreach ($spec in $services) {
        $spec.touched = $true
        Stop-ServiceTask $spec
    }
    foreach ($spec in $assets | Where-Object { !$_.unchanged }) {
        $spec.scriptTouched = $true
        Copy-Item -LiteralPath $spec.candidate -Destination $spec.liveScript -Force
    }
    foreach ($spec in $services) { Register-TaskXml $spec $spec.xml }
    $after = [DateTime]::UtcNow
    foreach ($spec in $services) { Start-ScheduledTask -TaskName $spec.name -TaskPath '\' }
    Wait-ServiceTasks $after @($services)

    if ($includeNative) {
        $receipt.stage = 'switch-native'
        Write-Receipt
        $desktopSpec.touched = $true
        Stop-TaskInstance $desktopSpec
        Register-TaskXml $desktopSpec $desktopSpec.xml
        $oldManaged = Read-Json "$nativeRoot\state\managed.json" -Required
        if (!$oldManaged.supervisor.pid -or !$oldManaged.supervisor.started) { throw 'The previous native supervisor identity is unavailable.' }
        $oldStarted = ([DateTimeOffset]$oldManaged.supervisor.started).UtcDateTime.ToString('o')
        $nativeArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -DeploymentRoot "{1}" -ExpectedSupervisorPid {2} -ExpectedSupervisorStarted "{3}" -CandidateConfig "{4}" -CandidateTaskXml "{5}"' -f
            (Join-Path $nativeCandidate 'update.ps1'), $nativeRoot, [int]$oldManaged.supervisor.pid, $oldStarted, $candidateConfig, $nativeSpec.xml
        $nativeAfter = [DateTime]::UtcNow
        $update = Start-Process -FilePath $powershell -ArgumentList $nativeArgs -WindowStyle Hidden -Wait -PassThru
        $nativeResult = Read-Json "$nativeRoot\state\update-result.json"
        $nativeResultFresh = $nativeResult.started -and ([DateTimeOffset]$nativeResult.started).UtcDateTime -ge $nativeAfter
        if (!$nativeResultFresh) {
            $recoveryErrors.Add('The native updater returned no current receipt. Inspect the native task and state before retrying.')
            throw 'The native update outcome could not be verified.'
        }
        if ($update.ExitCode -or !$nativeResult.ready) {
            $receipt.nativeUpdate = @{ exitCode = $update.ExitCode; rolledBack = $nativeResult.rolledBack; recoveryError = $nativeResult.recoveryError }
            if ($nativeResult.recoveryError) { $recoveryErrors.Add('Native updater reported a recovery failure. See windows-native\state\update-result.json.') }
            throw 'Native background update failed. See windows-native\state\update-result.json.'
        }
        $receipt.tasks[$nativeSpec.name].worker = $nativeResult.managed.daemon
        try {
            Start-ScheduledTask -TaskName $desktopSpec.name -TaskPath '\'
            $receipt.desktopStartRequested = $true
        } catch { $receipt.desktopStartError = $_.Exception.Message }
    }
    $receipt.status = 'installed'
    $receipt.stage = 'complete'
} catch {
    $receipt.status = 'failed'
    $receipt.error = $_.Exception.Message
    $receipt.errorLine = $_.InvocationInfo.ScriptLineNumber
    if ($desktopSpec.touched) { Invoke-Recovery $desktopSpec.name { Stop-TaskInstance $desktopSpec; Restore-Task $desktopSpec } }
    $touchedServices = @($services | Where-Object { $_.touched })
    foreach ($spec in $touchedServices) {
        Invoke-Recovery "Stop $($spec.name)" {
            Stop-ServiceTask $spec
            $spec.stoppedForRecovery = $true
        }
    }
    if (@($touchedServices | Where-Object { !$_.stoppedForRecovery }).Count -eq 0) {
        foreach ($asset in $assets | Where-Object { $_.scriptTouched }) {
            Invoke-Recovery "Restore $($asset.entry)" {
                if ($asset.backup) { Copy-Item -LiteralPath $asset.backup -Destination $asset.liveScript -Force }
                elseif (Test-Path -LiteralPath $asset.liveScript) { Remove-Item -LiteralPath $asset.liveScript -Force }
            }
        }
    }
    foreach ($spec in $touchedServices) {
        Invoke-Recovery "Restore $($spec.name)" { Restore-Task $spec }
    }
    $restarted = @($touchedServices | Where-Object { $_.wasEnabled -and $_.wasRunning })
    if ($restarted.Count) {
        Invoke-Recovery 'Service readiness after rollback' { Wait-ServiceTasks ([datetime]::MinValue) $restarted -Restore }
    }
    if ($recoveryErrors.Count) {
        $receipt.status = 'rollback-failed'
        $receipt.recoveryErrors = @($recoveryErrors.ToArray())
        $receipt.recoveryFiles = $staging
    } elseif ($desktopSpec.touched -or $wslSpec.touched -or $runnerSpec.touched) { $receipt.status = 'rolled-back' }
    throw
} finally {
    try {
        $receipt.finishedUtc = [DateTime]::UtcNow.ToString('o')
        Write-Receipt
        if (!$recoveryErrors.Count -and (Test-Path -LiteralPath $staging -PathType Container)) {
            $resolved = (Resolve-Path -LiteralPath $staging).ProviderPath
            if ($resolved -eq $staging -and (Split-Path -Parent $resolved) -eq $receiptDirectory) {
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
        }
    } finally { $lock.Dispose() }
}
$receipt | ConvertTo-Json -Depth 8
