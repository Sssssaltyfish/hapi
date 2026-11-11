$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath "$PSScriptRoot\config.json" -Raw | ConvertFrom-Json
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($config.ownerSid -ne $ownerSid) { throw 'Run task configuration as the deployment owner.' }
$task = Get-ScheduledTask -TaskName $config.taskName -TaskPath '\'
$entry = Join-Path $PSScriptRoot 'run.ps1'
if ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -notmatch ('(?:^|\s)"' + [regex]::Escape($entry) + '"(?:\s|$)')) {
    throw 'Unexpected managed task action.'
}
$principal = $task.Principal.UserId
if ($principal -notlike 'S-1-*') {
    $principal = [Security.Principal.NTAccount]::new($principal).Translate([Security.Principal.SecurityIdentifier]).Value
}
if ($principal -ne $ownerSid -or $task.Principal.RunLevel -ne 'Limited') { throw 'Unexpected managed task principal.' }
if ($config.launchDesktop -eq $false) {
    $bootstrap = Join-Path (Split-Path -Parent $PSScriptRoot) 'task-bootstrap.js'
    $expectedArguments = "//B //NoLogo `"$bootstrap`" `"$entry`" `"$PSScriptRoot`""
    if ($task.Principal.LogonType -ne 'Interactive' -or
        $task.Actions[0].Execute -ne (Join-Path ([Environment]::SystemDirectory) 'wscript.exe') -or
        $task.Actions[0].Arguments -ne $expectedArguments -or $task.Actions[0].WorkingDirectory -ne $PSScriptRoot -or
        $task.Triggers.Count -ne 1 -or $task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger') {
        throw 'The native backend requires the shared interactive logon task definition.'
    }
}
$task.Settings.StartWhenAvailable = $true
$task.Settings.RestartCount = 3
$task.Settings.RestartInterval = 'PT1M'
if ($config.launchDesktop -eq $false) {
    Set-ScheduledTask -TaskName $config.taskName -TaskPath '\' -Settings $task.Settings | Out-Null
} else {
    foreach ($trigger in $task.Triggers) {
        if ($trigger.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { $trigger.Delay = 'PT10S' }
    }
    Set-ScheduledTask -TaskName $config.taskName -TaskPath '\' -Settings $task.Settings -Trigger $task.Triggers | Out-Null
}
