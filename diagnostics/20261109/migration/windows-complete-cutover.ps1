$ErrorActionPreference = 'Stop'
$oldRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$newRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'HAPI'))
$workspace = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'codex-temp'))
if ($oldRoot -ne (Join-Path $workspace 'hapi-deployment')) { throw 'Unexpected source root' }
$result = [ordered]@{startedUtc=[DateTime]::UtcNow.ToString('o');status='running'}
try {
    & "$oldRoot\ops\deployment\migrate-windows-runtime.ps1" -OldRoot $oldRoot -NewRoot $newRoot -ReceiptDirectory $PSScriptRoot -WorkspaceRoot $workspace -Migrate
    $migration = Get-Content -LiteralPath "$PSScriptRoot\windows-runtime-migration.json" -Raw | ConvertFrom-Json
    if ($migration.status -ne 'migrated' -or $migration.activeRoot -ne $newRoot) { throw 'Migration did not become ready' }
    $names = @('HAPI-Windows-Runner', ('HAPI Codex Native ' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
    foreach ($name in $names) {
        $task = Get-ScheduledTask -TaskName $name
        if ($task.State -ne 'Running' -or $task.Actions.Count -ne 1 -or
            !$task.Actions[0].Execute.StartsWith($newRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'New task is not active' }
    }
    $targets = @('package', 'windows-state', 'windows-native', 'hidden-task-launcher', 'start-windows-runner.ps1', 'windows-runner.log')
    $processes = @(Get-CimInstance Win32_Process)
    $removed = @()
    foreach ($name in $targets) {
        $path = (Resolve-Path -LiteralPath (Join-Path $oldRoot $name)).ProviderPath
        if ((Split-Path -Parent $path) -ne $oldRoot -or $path -ne (Join-Path $oldRoot $name)) { throw 'Unexpected cleanup target' }
        $item = Get-Item -LiteralPath $path -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected cleanup link' }
        foreach ($process in $processes) {
            if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($path, [StringComparison]::OrdinalIgnoreCase)) -or
                ($process.CommandLine -and $process.CommandLine.Contains($path))) { throw "Old runtime is still in use: $name" }
        }
        Remove-Item -LiteralPath $path -Recurse -Force
        $removed += $name
    }
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:3006/health')
    $request.Proxy = $null
    $request.Timeout = 10000
    $response = $request.GetResponse()
    try { $result.hubHttp = [int]$response.StatusCode } finally { $response.Dispose() }
    $native = Get-Content -LiteralPath "$newRoot\windows-native\state\managed.json" -Raw | ConvertFrom-Json
    $result.status = 'complete'
    $result.activeRoot = $newRoot
    $result.removedOldRuntime = $removed
    $result.native = [ordered]@{daemonReady=$native.daemonReady;toolsPipeReady=$native.toolsPipeReady;desktopBackendConnected=$native.desktopBackendConnected;daemonPid=$native.daemon.pid;supervisorPid=$native.supervisor.pid}
} catch {
    $result.status = 'needs-review'
    $result.error = $_.Exception.Message
} finally {
    $result.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$PSScriptRoot\windows-cutover-result.json" -Encoding utf8
    if (Test-Path -LiteralPath $newRoot) {
        $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$newRoot\windows-cutover-result.json" -Encoding utf8
    }
    Unregister-ScheduledTask -TaskName 'HAPI Windows Runtime Migration 20261109' -Confirm:$false -ErrorAction SilentlyContinue
}
