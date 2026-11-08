param(
    [Parameter(Mandatory)][string]$NodeExe,
    [string]$McpNodeExe = $env:CODEX_MCP_NODE_PATH,
    [string]$BrowserNodeExe = $env:CODEX_BROWSER_USE_NODE_PATH,
    [string]$CodexHome = "$env:USERPROFILE\.codex",
    [ValidateRange(1024,65535)][int]$Port = 17844
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$ownerTag = ($owner.User.Value -replace '[^a-zA-Z0-9-]','')
if (Test-Path -LiteralPath "$root\config.json") { throw 'Existing managed configuration: review it before replacing.' }
if (!$McpNodeExe) { $McpNodeExe = $NodeExe }
if (!$BrowserNodeExe) { $BrowserNodeExe = $McpNodeExe }
foreach ($file in @($NodeExe,$McpNodeExe,$BrowserNodeExe)) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Required runtime missing.' } }
if (!(Test-Path -LiteralPath $CodexHome -PathType Container)) { throw 'Existing Codex home missing.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
try { $listener.Start() } finally { $listener.Stop() }
$proxies = @{}
foreach ($key in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')) {
    $value = [Environment]::GetEnvironmentVariable($key,'Process')
    if ($value) { $proxies[$key] = $value }
}
$config = @{nodeExe=$NodeExe;mcpNodeExe=$McpNodeExe;browserNodeExe=$BrowserNodeExe;proxyEnvironment=$proxies;codexHome=[IO.Path]::GetFullPath($CodexHome);ownerSid=$owner.User.Value;ownerTag=$ownerTag;websocketUrl="ws://127.0.0.1:$Port";taskName="HAPI Codex Native $ownerTag"}
if (Get-ScheduledTask -TaskName $config.taskName -ErrorAction SilentlyContinue) { throw 'Managed task already exists.' }
$previousWsUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
$registered = $false
try {
    # Private config can contain an authenticated proxy URL; never print its contents.
    & icacls.exe $root /inheritance:r /grant:r "*$($owner.User.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Private deployment ACL failed.' }
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$root\config.json" -Encoding UTF8
    New-Item -ItemType Directory -Path "$root\state" -Force | Out-Null
    @{previousWsUrl=$previousWsUrl} | ConvertTo-Json | Set-Content "$root\state\rollback.json" -Encoding UTF8
    & "$root\resolve-runtime.ps1" -Config "$root\config.json" | Out-Null
    $summary = @{}
    foreach ($key in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')) {
        $entry = @{present=$proxies.ContainsKey($key)}
        if ($entry.present -and $key -ne 'NO_PROXY') {
            try { $uri=[Uri]$proxies[$key]; $entry.host=$uri.Host; $entry.port=$uri.Port } catch {}
        }
        $summary[$key] = $entry
    }
    $summary | ConvertTo-Json -Depth 4 | Set-Content "$root\state\proxy-summary.json" -Encoding UTF8
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\run.ps1`"" -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner.Name
    $principal = New-ScheduledTaskPrincipal -UserId $owner.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $config.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',$config.websocketUrl,'User')
} catch {
    if ($registered) { Unregister-ScheduledTask -TaskName $config.taskName -Confirm:$false -ErrorAction SilentlyContinue }
    [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',$previousWsUrl,'User')
    Remove-Item -LiteralPath "$root\config.json","$root\state\rollback.json","$root\state\proxy-summary.json" -Force -ErrorAction SilentlyContinue
    throw
}
@{installed=$true;taskName=$config.taskName;url=$config.websocketUrl;started=$false} | ConvertTo-Json
