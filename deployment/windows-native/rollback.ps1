$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$backup = Get-Content -LiteralPath "$root\state\rollback.json" -Raw | ConvertFrom-Json
$managed = if (Test-Path -LiteralPath "$root\state\managed.json") { Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json }
function Matching-Process($Identity) {
    if (!$Identity) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)"
    if (!$process) { return $null }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if ($process.CreationDate.ToUniversalTime().ToString('o') -ne $Identity.started -or $owner.Sid -ne $config.ownerSid -or $process.ExecutablePath -ne $Identity.executable) { return $null }
    $process
}
New-Item -ItemType File -Path "$root\state\stop" -Force | Out-Null
$until = (Get-Date).AddSeconds(15)
while ((Matching-Process $managed.supervisor) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 250 }
foreach ($identity in @($managed.supervisor,$managed.desktop,$managed.daemon)) {
    if (Matching-Process $identity) { & taskkill.exe /PID $identity.pid /T /F | Out-Null }
}
foreach ($identity in @($managed.supervisor,$managed.desktop,$managed.daemon)) {
    if (Matching-Process $identity) { throw 'Managed process still running; refusing a second Desktop launch.' }
}
Unregister-ScheduledTask -TaskName $config.taskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "$($config.taskName) switch" -Confirm:$false -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',$backup.previousWsUrl,'User')
Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
if ($backup.previousWsUrl) { $env:CODEX_APP_SERVER_WS_URL=$backup.previousWsUrl }
$runtime = & "$root\resolve-runtime.ps1" -Config "$root\config.json" | ConvertFrom-Json
Remove-Item -LiteralPath "$root\state\managed.json","$root\state\managed.json.tmp","$root\state\stop","$root\state\open","$root\state\stopped.json" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $runtime.desktopExe -WindowStyle Hidden
@{rolledBack=$true;homePreserved=$config.codexHome} | ConvertTo-Json
