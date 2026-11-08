param(
    [Parameter(Mandatory)][int]$OldDesktopPid,
    [Parameter(Mandatory)][string]$OldDesktopStarted,
    [Parameter(Mandatory)][int]$OldBackendPid,
    [Parameter(Mandatory)][string]$OldBackendStarted
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments="-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\switch.ps1`" -OldDesktopPid $OldDesktopPid -OldDesktopStarted `"$OldDesktopStarted`" -OldBackendPid $OldBackendPid -OldBackendStarted `"$OldBackendStarted`""
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $root
$principal=New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
$startsAt=(Get-Date).AddSeconds(30)
$trigger=New-ScheduledTaskTrigger -Once -At $startsAt
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "$($config.taskName) switch" -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
@{scheduled=$true;startsAt=$startsAt.ToUniversalTime().ToString('o');ready=$null} | ConvertTo-Json | Set-Content -LiteralPath "$root\state\switch-result.json" -Encoding UTF8
@{scheduled=$true;startsInSeconds=30;result="$root\state\switch-result.json"} | ConvertTo-Json
