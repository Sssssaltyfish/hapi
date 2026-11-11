param(
    [ValidatePattern('^[^"\r\n]+$')][string]$Distribution = 'Ubuntu-26.04',
    [ValidatePattern('^[^"\r\n]+$')][string]$LinuxUser = 'igna'
)

$ErrorActionPreference = 'Stop'
$wsl = Join-Path ([Environment]::SystemDirectory) 'wsl.exe'
. (Join-Path $PSScriptRoot 'task-lifetime.ps1')

$distributionArg = if ($Distribution -match '\s') { '"{0}"' -f ($Distribution -replace '(\\+)$', '$1$1') } else { $Distribution }
$userArg = if ($LinuxUser -match '\s') { '"{0}"' -f ($LinuxUser -replace '(\\+)$', '$1$1') } else { $LinuxUser }
$arguments = '--distribution {0} --user {1} --cd / --exec /bin/cat' -f $distributionArg, $userArg
$launcher = Get-TaskLauncher
$instance = $null
$writer = $null
try {
    $instance = Enter-TaskInstance $launcher (Join-Path $PSScriptRoot 'wsl-services.lock')
    if (!$instance) { return }
    try { $writer = Open-TaskLog (Join-Path $PSScriptRoot 'wsl-services.log') } catch { Write-Warning $_.Exception.Message }
    $delay = 5
    while (Test-TaskLauncherRunning $launcher) {
        $attempt = [Diagnostics.Stopwatch]::StartNew()
        try {
            # A foreground Linux reader keeps the distribution alive until the client closes stdin.
            $code = Invoke-TaskChild -Launcher $launcher -Log $writer -Executable $wsl -Arguments $arguments -WorkingDirectory $PSScriptRoot -KeepInputOpen
            if ($null -eq $code) { break }
            Write-TaskStatus $writer "WSL keeper exited with code $code."
        } catch {
            Write-TaskStatus $writer $_.Exception.GetBaseException().Message
        }
        if ($attempt.Elapsed.TotalSeconds -ge 60) { $delay = 5 }
        Write-TaskStatus $writer "Retrying WSL keeper in $delay seconds."
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
