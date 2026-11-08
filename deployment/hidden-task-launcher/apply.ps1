$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$deployment = Split-Path $root -Parent
$launcher = Join-Path $root 'HiddenTaskLauncher.exe'
$nativeName = 'HAPI Codex Native ' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$specs = @(
    @{name='HAPI-Windows-Runner'; script="$deployment\start-windows-runner.ps1"; directory='C:\Users\Igna\codex-temp'; suffix=''; backup='runner-before.xml'},
    @{name=$nativeName; script="$deployment\windows-native\run.ps1"; directory="$deployment\windows-native"; suffix=' Bypass'; backup='native-before.xml'}
)
foreach ($spec in $specs) {
    $task = Get-ScheduledTask -TaskName $spec.name
    if ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -notlike "*$($spec.script)*") { throw 'Unexpected task action; no update applied to this task.' }
    $backup = Join-Path $root $spec.backup
    if (!(Test-Path -LiteralPath $backup)) { Export-ScheduledTask -TaskName $spec.name | Set-Content -LiteralPath $backup -Encoding Unicode }
    $action = New-ScheduledTaskAction -Execute $launcher -Argument ('"' + $spec.script + '" "' + $spec.directory + '"' + $spec.suffix) -WorkingDirectory $spec.directory
    Set-ScheduledTask -TaskName $spec.name -Action $action | Out-Null
}
Get-ScheduledTask -TaskName 'HAPI-Windows-Runner',$nativeName | ForEach-Object {
    [pscustomobject]@{Name=$_.TaskName;State=[string]$_.State;Actions=@($_.Actions | Select-Object Execute,Arguments,WorkingDirectory)}
} | ConvertTo-Json -Depth 4
