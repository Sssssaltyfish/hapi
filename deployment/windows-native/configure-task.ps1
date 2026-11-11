$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath "$PSScriptRoot\config.json" -Raw | ConvertFrom-Json
$task = Get-ScheduledTask -TaskName $config.taskName
if ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -notlike "*$PSScriptRoot\run.ps1*") {
    throw 'Unexpected managed task action.'
}
# Preserve the deployed hidden launcher (or the standard PowerShell action).
$task.Settings.StartWhenAvailable = $true
$task.Settings.RestartCount = 3
$task.Settings.RestartInterval = 'PT1M'
if ($config.launchDesktop -eq $false) {
    Set-ScheduledTask -TaskName $config.taskName -Settings $task.Settings | Out-Null
} else {
    foreach ($trigger in $task.Triggers) {
        if ($trigger.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { $trigger.Delay = 'PT10S' }
    }
    Set-ScheduledTask -TaskName $config.taskName -Settings $task.Settings -Trigger $task.Triggers | Out-Null
}
