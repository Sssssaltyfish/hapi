$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\native-task.ps1"
$config = Get-Content -LiteralPath "$PSScriptRoot\config.json" -Raw | ConvertFrom-Json
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($config.ownerSid -ne $ownerSid) { throw 'Run task configuration as the deployment owner.' }
$task = Get-CodexDeploymentTask -Root $PSScriptRoot -Name $config.taskName -OwnerSid $ownerSid -Entry 'run.ps1' -AllowLegacy
$task.Settings.StartWhenAvailable = $true
$task.Settings.RestartCount = 3
$task.Settings.RestartInterval = 'PT1M'
Set-ScheduledTask -TaskName $config.taskName -TaskPath '\' -Settings $task.Settings | Out-Null
