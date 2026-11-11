param(
    [Parameter(Mandatory)][int]$OldDesktopPid,
    [Parameter(Mandatory)][string]$OldDesktopStarted,
    [Parameter(Mandatory)][int]$OldBackendPid,
    [Parameter(Mandatory)][string]$OldBackendStarted
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$result = @{started=[DateTime]::UtcNow.ToString('o');modelInputs=0;approvalTests=0;interruptTests=0}
function Exact-Process([int]$ProcessId,[string]$Started,[string]$Name) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
    if (!$process) { return $null }
    if ($process.Name -ne $Name -or $process.CreationDate.ToUniversalTime().ToString('o') -ne ([DateTime]$Started).ToUniversalTime().ToString('o')) { throw 'Original process identity changed; refusing stop.' }
    $process
}
try {
    # Validate both before terminating either. These exact identities must be supplied by the parent review.
    Exact-Process $OldDesktopPid $OldDesktopStarted 'ChatGPT.exe' | Out-Null
    Exact-Process $OldBackendPid $OldBackendStarted 'codex.exe' | Out-Null
    $desktop = Get-Process -Id $OldDesktopPid -ErrorAction SilentlyContinue
    if ($desktop) { $desktop.CloseMainWindow() | Out-Null; $desktop.WaitForExit(10000) | Out-Null }
    if (Exact-Process $OldDesktopPid $OldDesktopStarted 'ChatGPT.exe') { & taskkill.exe /PID $OldDesktopPid /T /F | Out-Null }
    if (Exact-Process $OldBackendPid $OldBackendStarted 'codex.exe') { Stop-Process -Id $OldBackendPid -Force }
    Remove-Item -LiteralPath "$root\state\managed.json","$root\state\stopped.json","$root\state\stop" -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $config.taskName
    $until=(Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Seconds 1
        if (Test-Path -LiteralPath "$root\state\managed.json") {
            $state=Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json
            if ($state.daemonReady -and ($config.launchDesktop -eq $false -or ($state.toolsPipeReady -and $state.desktopBackendConnected))) { $result.managed=$state;break }
        }
    } while ((Get-Date) -lt $until)
    $result.ready=!!$result.managed
    if (!$result.ready) { throw 'Managed readiness did not complete.' }
    if ($config.launchDesktop -eq $false -and $config.desktopTaskName) { Start-ScheduledTask -TaskName $config.desktopTaskName }
    # A read-only HAPI check runs outside the Desktop process tree.
    $postflight = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$root\hapi\postflight.ps1`"", '-EndpointConfigPath', '/home/igna/.config/hapi/native-endpoints.json') -WindowStyle Hidden -PassThru
    if ($postflight.WaitForExit(50000)) {
        $postflight.Refresh()
        $result.hapiReady = $postflight.ExitCode -eq 0
    } else { $result.hapiReady = $false }
} catch { $result.failureType=$_.Exception.GetType().FullName;$result.hresult=$_.Exception.HResult }
finally {
    if (!$result.ready) {
        try { & "$root\rollback.ps1" | Out-Null; $result.automaticRollback=$true }
        catch { $result.automaticRollback=$false; $result.rollbackFailureType=$_.Exception.GetType().FullName }
    }
    $result.finished=[DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 6 | Set-Content "$root\state\switch-result.json" -Encoding UTF8
    Unregister-ScheduledTask -TaskName "$($config.taskName) switch" -Confirm:$false -ErrorAction SilentlyContinue
}
