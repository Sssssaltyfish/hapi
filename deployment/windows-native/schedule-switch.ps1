param(
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$OldDesktopPid,
    [Parameter(Mandatory)][string]$OldDesktopStarted,
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$OldBackendPid,
    [Parameter(Mandatory)][string]$OldBackendStarted
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($owner.User.Value -ne $config.ownerSid -or (Get-Process -Id $PID).SessionId -eq 0) { throw 'Schedule the switch in an interactive Windows session as the deployment owner.' }
$requestPath = "$root\state\switch-request.json"
$resultPath = "$root\state\switch-result.json"
$taskName = "$($config.taskName) switch"
$bootstrap = Join-Path (Split-Path -Parent $root) 'task-bootstrap.js'
if (!(Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'The shared task bootstrap is missing.' }
$request = @{
    oldDesktopPid = $OldDesktopPid
    oldDesktopStarted = ([DateTimeOffset]$OldDesktopStarted).UtcDateTime.ToString('o')
    oldBackendPid = $OldBackendPid
    oldBackendStarted = ([DateTimeOffset]$OldBackendStarted).UtcDateTime.ToString('o')
}
$lock = [IO.File]::Open("$root\state\switch.lock", 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if ((Test-Path -LiteralPath $requestPath) -or (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) {
        throw 'A switch is already scheduled.'
    }
    $action = New-ScheduledTaskAction -Execute (Join-Path ([Environment]::SystemDirectory) 'wscript.exe') -Argument "//B //NoLogo `"$bootstrap`" `"$root\switch.ps1`" `"$root`"" -WorkingDirectory $root
    $principal = New-ScheduledTaskPrincipal -UserId $owner.Name -LogonType Interactive -RunLevel Limited
    $startsAt = (Get-Date).AddSeconds(30)
    $trigger = New-ScheduledTaskTrigger -Once -At $startsAt
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    try {
        $request | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
        @{scheduled=$true;startsAt=$startsAt.ToUniversalTime().ToString('o');ready=$null} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
        Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
    } catch {
        Remove-Item -LiteralPath $requestPath,$resultPath -Force -ErrorAction SilentlyContinue
        throw
    }
} finally { $lock.Dispose() }
@{scheduled=$true;startsInSeconds=30;result=$resultPath} | ConvertTo-Json
