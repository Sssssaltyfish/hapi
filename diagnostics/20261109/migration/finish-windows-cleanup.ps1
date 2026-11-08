$ErrorActionPreference = 'Stop'
$oldRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$newRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'HAPI'))
if ($oldRoot -ne (Join-Path $env:USERPROFILE 'codex-temp\hapi-deployment')) { throw 'Unexpected old root' }
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$migration = Get-Content -LiteralPath "$PSScriptRoot\windows-runtime-migration.json" -Raw | ConvertFrom-Json
if ($migration.status -ne 'migrated' -or $migration.activeRoot -ne $newRoot) { throw 'Migration not ready' }
$oldExe = Join-Path $oldRoot 'package\bin\hapi.exe'
$oldEntry = Join-Path $oldRoot 'start-windows-runner.ps1'
$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$stopped = @()
function Stop-Exact($record) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.ProcessId)"
    if (!$current) { return }
    if ($current.CreationDate -ne $record.CreationDate -or $current.ExecutablePath -ne $record.ExecutablePath -or
        (Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid).Sid -ne $ownerSid) { throw 'Process identity changed' }
    $process = Get-Process -Id $current.ProcessId
    $null = $process.Handle
    $process.Kill()
    if (!$process.WaitForExit(5000)) { throw 'Old runner did not stop' }
}
foreach ($runner in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $oldExe })) {
    if ($runner.CommandLine -notmatch ' runner start-sync(?: |$)' -or
        (Invoke-CimMethod -InputObject $runner -MethodName GetOwnerSid).Sid -ne $ownerSid) { throw 'Unrecognized old runner' }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($runner.ParentProcessId)"
    if ($parent) {
        if ($parent.ExecutablePath -ne $powershell -or !$parent.CommandLine.Contains($oldEntry) -or
            $parent.CreationDate -gt $runner.CreationDate) { throw 'Unrecognized old retry loop' }
        Stop-Exact $parent
        $stopped += $parent.ProcessId
    }
    Stop-Exact $runner
    $stopped += $runner.ProcessId
}
$names = @('HAPI-Windows-Runner', ('HAPI Codex Native ' + $ownerSid))
foreach ($name in $names) {
    $task = Get-ScheduledTask -TaskName $name
    if ($task.State -ne 'Running' -or $task.Actions.Count -ne 1 -or
        !$task.Actions[0].Execute.StartsWith($newRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'New task is not active' }
}
$removed = @()
$processes = @(Get-CimInstance Win32_Process)
foreach ($name in @('package', 'windows-state', 'windows-native', 'hidden-task-launcher', 'start-windows-runner.ps1', 'windows-runner.log')) {
    $candidate = Join-Path $oldRoot $name
    if (!(Test-Path -LiteralPath $candidate)) { continue }
    $path = (Resolve-Path -LiteralPath $candidate).ProviderPath
    if ((Split-Path -Parent $path) -ne $oldRoot -or $path -ne $candidate -or
        ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected cleanup target' }
    if ($processes | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($path, [StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.Contains($path)) }) { throw "Old target still used: $name" }
    Remove-Item -LiteralPath $path -Recurse -Force
    $removed += $name
}
$native = Get-Content -LiteralPath "$newRoot\windows-native\state\managed.json" -Raw | ConvertFrom-Json
if (!$native.daemonReady -or !$native.toolsPipeReady -or !$native.desktopBackendConnected) { throw 'Native is not ready' }
$result = [ordered]@{status='complete';activeRoot=$newRoot;stoppedOldProcesses=$stopped;removedOldRuntime=$removed;
    native=@{daemonReady=$native.daemonReady;toolsPipeReady=$native.toolsPipeReady;desktopBackendConnected=$native.desktopBackendConnected;daemonPid=$native.daemon.pid;supervisorPid=$native.supervisor.pid};
    finishedUtc=[DateTime]::UtcNow.ToString('o')}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$PSScriptRoot\windows-cutover-result.json" -Encoding utf8
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$newRoot\windows-cutover-result.json" -Encoding utf8
$result | ConvertTo-Json -Depth 5
