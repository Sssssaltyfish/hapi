param([string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'HAPI'))

$ErrorActionPreference = 'Stop'
$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).ProviderPath
$script = Join-Path $RuntimeRoot 'start-wsl-services.ps1'
$launcher = Join-Path $RuntimeRoot 'hidden-task-launcher\HiddenTaskLauncher.exe'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Runtime launcher is missing' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-wsl-services.ps1') -Destination $script -Force
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName = 'Seia-WSL-Services'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'WSL services task already exists' }
$action = New-ScheduledTaskAction -Execute $launcher -Argument ('"{0}" "{1}"' -f $script, $RuntimeRoot) -WorkingDirectory $RuntimeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner
$principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
