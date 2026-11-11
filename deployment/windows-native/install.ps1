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
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Run setup in an interactive Windows session as the deployment owner.' }
if (Test-Path -LiteralPath "$root\config.json") { throw 'Existing managed configuration: review it before replacing.' }
$runtimeRoot = Split-Path -Parent $root
foreach ($file in @('task-bootstrap.js','task-launcher.ps1','task-lifetime.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $runtimeRoot $file) -PathType Leaf)) { throw "Install the shared $file beside windows-native before setup." }
}
if (!$McpNodeExe) { $McpNodeExe = $NodeExe }
if (!$BrowserNodeExe) { $BrowserNodeExe = $McpNodeExe }
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).ProviderPath
$McpNodeExe = (Resolve-Path -LiteralPath $McpNodeExe).ProviderPath
$BrowserNodeExe = (Resolve-Path -LiteralPath $BrowserNodeExe).ProviderPath
foreach ($file in @($NodeExe,$McpNodeExe,$BrowserNodeExe)) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Required runtime missing.' } }
if (!(Test-Path -LiteralPath $CodexHome -PathType Container)) { throw 'Existing Codex home missing.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
try { $listener.Start() } finally { $listener.Stop() }
$proxies = @{}
foreach ($key in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')) {
    $value = [Environment]::GetEnvironmentVariable($key,'Process')
    if ($value) { $proxies[$key] = $value }
}
$config = @{
    nodeExe = $NodeExe
    mcpNodeExe = $McpNodeExe
    browserNodeExe = $BrowserNodeExe
    proxyEnvironment = $proxies
    codexHome = (Resolve-Path -LiteralPath $CodexHome).ProviderPath
    ownerSid = $owner.User.Value
    ownerTag = $ownerTag
    websocketUrl = "ws://127.0.0.1:$Port"
    launchDesktop = $false
    taskName = "HAPI Codex Native $ownerTag"
    desktopTaskName = "HAPI Codex Desktop $ownerTag"
}
$tasks = @(
    @{ name = $config.taskName; script = 'run.ps1'; delay = 'PT10S' }
    @{ name = $config.desktopTaskName; script = 'desktop.ps1'; delay = 'PT15S' }
)
foreach ($task in $tasks) {
    if (!(Test-Path -LiteralPath (Join-Path $root $task.script) -PathType Leaf)) { throw "Missing $($task.script)." }
}
foreach ($name in @($config.taskName, $config.desktopTaskName, "$($config.taskName) switch")) {
    if (Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue) { throw "A task already exists for this deployment: $name." }
}
$previousWsUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
$registered = @()
$migrationLock = $null
$configCreated = $false
try {
    # Private config can contain an authenticated proxy URL; never print its contents.
    & icacls.exe $root /inheritance:r /grant:r "*$($owner.User.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Private deployment ACL failed.' }
    New-Item -ItemType Directory -Path "$root\state" -Force | Out-Null
    $migrationLock = [IO.File]::Open("$root\state\switch.lock", 'OpenOrCreate', 'ReadWrite', 'None')
    if (Test-Path -LiteralPath "$root\config.json") { throw 'Existing managed configuration: review it before replacing.' }
    $configCreated = $true
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$root\config.json" -Encoding UTF8
    @{previousWsUrl=$previousWsUrl;staged=$true} | ConvertTo-Json | Set-Content -LiteralPath "$root\state\rollback.json" -Encoding UTF8
    $runtime = & "$root\resolve-runtime.ps1" -Config "$root\config.json" | ConvertFrom-Json
    $config.desktopExe = $runtime.desktopExe
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$root\config.json" -Encoding UTF8
    $bootstrap = Join-Path $runtimeRoot 'task-bootstrap.js'
    $principal = New-ScheduledTaskPrincipal -UserId $owner.Name -LogonType Interactive -RunLevel Limited
    foreach ($task in $tasks) {
        $entry = Join-Path $root $task.script
        $action = New-ScheduledTaskAction -Execute (Join-Path ([Environment]::SystemDirectory) 'wscript.exe') -Argument "//B //NoLogo `"$bootstrap`" `"$entry`" `"$root`"" -WorkingDirectory $root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner.Name
        $trigger.Delay = $task.delay
        # Arm both logon triggers only after the old Desktop has closed.
        $taskSettings = @{
            Disable = $true
            AllowStartIfOnBatteries = $true
            DontStopIfGoingOnBatteries = $true
            StartWhenAvailable = $true
            ExecutionTimeLimit = [TimeSpan]::Zero
            MultipleInstances = 'IgnoreNew'
        }
        if ($task.name -eq $config.taskName) {
            $taskSettings.RestartCount = 3
            $taskSettings.RestartInterval = New-TimeSpan -Minutes 1
        }
        $settings = New-ScheduledTaskSettingsSet @taskSettings
        Register-ScheduledTask -TaskName $task.name -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
        $registered += $task.name
    }
} catch {
    foreach ($name in $registered) { Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue }
    if ($configCreated) { Remove-Item -LiteralPath "$root\config.json","$root\state\rollback.json" -Force -ErrorAction SilentlyContinue }
    throw
} finally { if ($migrationLock) { $migrationLock.Dispose() } }
@{installed=$true;taskName=$config.taskName;desktopTaskName=$config.desktopTaskName;url=$config.websocketUrl;started=$false} | ConvertTo-Json
