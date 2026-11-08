[CmdletBinding()]
param([ValidateRange(30, 300)][int]$DelaySeconds = 60)

$ErrorActionPreference = 'Stop'
$oldRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Join-Path $env:USERPROFILE 'codex-temp'
$newRoot = Join-Path $env:LOCALAPPDATA 'HAPI'
$migration = Join-Path $oldRoot 'ops\deployment\migrate-windows-runtime.ps1'
$cutover = Join-Path $PSScriptRoot 'windows-complete-cutover.ps1'
$taskName = 'HAPI Windows Runtime Migration 20261109'

if ($PSScriptRoot -ne (Join-Path $workspaceRoot 'hapi-deployment\runtime-separation-20261109') -or
    !(Test-Path -LiteralPath $migration -PathType Leaf) -or !(Test-Path -LiteralPath $cutover -PathType Leaf)) { throw 'Unexpected migration script path.' }
& $migration -OldRoot $oldRoot -NewRoot $newRoot -ReceiptDirectory $PSScriptRoot -WorkspaceRoot $workspaceRoot | Out-Null
if (Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'The migration task already exists.'
}

$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $cutover
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$startsAt = (Get-Date).AddSeconds($DelaySeconds)
$trigger = New-ScheduledTaskTrigger -Once -At $startsAt
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
[ordered]@{
    taskName = $taskName
    startsUtc = $startsAt.ToUniversalTime().ToString('o')
    receipt = Join-Path $PSScriptRoot 'windows-runtime-migration.json'
    runtimeReceipt = Join-Path $newRoot 'windows-runtime-migration.json'
} | ConvertTo-Json
