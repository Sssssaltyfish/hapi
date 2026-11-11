param([string]$WorkspaceRoot)

$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$runner = Join-Path $taskRoot 'package\bin\hapi.exe'
$log = Join-Path $taskRoot 'windows-runner.log'
if (!$PSBoundParameters.ContainsKey('WorkspaceRoot')) {
    $WorkspaceRoot = if ($env:HAPI_TASK_LAUNCHER_PID) { (Get-Location).ProviderPath } else { Join-Path $env:USERPROFILE 'codex-temp' }
}
. (Join-Path $taskRoot 'task-lifetime.ps1')

$env:HAPI_HOME = Join-Path $taskRoot 'windows-state'
$env:HAPI_API_URL = 'http://127.0.0.1:3006'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:HTTP_PROXY = 'http://127.0.0.1:10880'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:ALL_PROXY = $env:HTTP_PROXY
$env:HAPI_RUNNER_SUPERVISED = '1'
$env:HAPI_DISABLE_VERSION_HANDOFF = '1'
$basePath = $env:PATH
$codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$launcher = Get-TaskLauncher
$instance = $null
$writer = $null
try {
    $instance = Enter-TaskInstance $launcher (Join-Path $taskRoot 'windows-runner.lock')
    if (!$instance) { return }
    try { $writer = Open-TaskLog $log } catch { Write-Warning $_.Exception.Message }
    $delay = 5
    while (Test-TaskLauncherRunning $launcher) {
        $attempt = [Diagnostics.Stopwatch]::StartNew()
        try {
            if (!(Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Runner executable is unavailable.' }
            $codexExe = Get-ChildItem -LiteralPath $codexBin -Filter codex.exe -File -Recurse |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if (!$codexExe) { throw 'Codex executable is unavailable.' }
            if (!(Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) { throw 'Runner workspace is unavailable.' }
            $workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).ProviderPath
            $env:PATH = "$($codexExe.DirectoryName);$basePath"
            $arguments = 'runner start-sync --workspace-root "{0}"' -f ($workspace -replace '(\\+)$', '$1$1')
            $code = Invoke-TaskChild -Launcher $launcher -Log $writer -Executable $runner -Arguments $arguments -WorkingDirectory $workspace
            if ($null -eq $code) { break }
            Write-TaskStatus $writer "Runner exited with code $code."
        } catch {
            Write-TaskStatus $writer $_.Exception.GetBaseException().Message
        }
        if ($attempt.Elapsed.TotalSeconds -ge 60) { $delay = 5 }
        Write-TaskStatus $writer "Retrying runner in $delay seconds."
        if (!(Wait-TaskRetry $launcher $delay)) { break }
        $delay = [Math]::Min(30, $delay * 2)
    }
} finally {
    try { if ($writer) { $writer.Dispose() } }
    finally {
        if ($instance) { $instance.Dispose() }
        if ($launcher.Process) { $launcher.Process.Dispose() }
    }
}
