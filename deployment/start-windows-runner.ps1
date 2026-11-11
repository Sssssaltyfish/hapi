$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$runner = Join-Path $taskRoot 'package\bin\hapi.exe'
$log = Join-Path $taskRoot 'windows-runner.log'
. (Join-Path $taskRoot 'service-settings.ps1')
. (Join-Path $taskRoot 'task-lifetime.ps1')

$launcher = Get-TaskLauncher
$instance = $null
$writer = $null
try {
    $instance = Enter-TaskInstance $launcher (Join-Path $taskRoot 'windows-runner.lock')
    if (!$instance) { return }
    try { $writer = Open-TaskLog $log } catch { Write-Warning $_.Exception.Message }
    $settings = Get-WindowsRunnerSettings (Read-ServiceSettings $taskRoot)
    $env:HAPI_HOME = Join-Path $taskRoot 'windows-state'
    $env:HAPI_API_URL = $settings.apiUrl
    Set-WindowsRunnerProxy $settings.environment
    $env:HAPI_RUNNER_SUPERVISED = '1'
    $env:HAPI_DISABLE_VERSION_HANDOFF = '1'
    $basePath = $env:PATH
    $codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $delay = 5
    while (Test-TaskLauncherRunning $launcher) {
        $attempt = [Diagnostics.Stopwatch]::StartNew()
        try {
            if (!(Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Runner executable is unavailable.' }
            $codexExe = Get-ChildItem -LiteralPath $codexBin -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            $env:PATH = if ($codexExe) { "$($codexExe.DirectoryName);$basePath" } else { $basePath }
            if (!(Test-Path -LiteralPath $settings.workspaceRoot -PathType Container)) { throw 'Runner workspace is unavailable.' }
            $workspace = (Resolve-Path -LiteralPath $settings.workspaceRoot).ProviderPath
            $arguments = 'runner start-sync --workspace-root ' + (ConvertTo-ServiceArgument $workspace)
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
} catch {
    Write-TaskStatus $writer $_.Exception.GetBaseException().Message
    throw
} finally {
    try { if ($writer) { $writer.Dispose() } }
    finally {
        if ($instance) { $instance.Dispose() }
        if ($launcher.Process) { $launcher.Process.Dispose() }
    }
}
