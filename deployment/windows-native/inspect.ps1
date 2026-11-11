param(
    [Parameter(Mandatory)][string]$NodeExe,
    [string]$DesktopExe,
    [string]$CliExe,
    [string]$CodexHome = "$env:USERPROFILE\.codex",
    [ValidateRange(1024,65535)][int]$Port = 17844,
    [switch]$CheckRunning,
    [switch]$RequireDesktop
)
$ErrorActionPreference = 'Stop'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$managedPath = Join-Path $PSScriptRoot 'state\managed.json'
$configPath = Join-Path $PSScriptRoot 'config.json'
$managedConfig = if ($CheckRunning -and (Test-Path -LiteralPath $configPath)) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
$checkDesktop = $RequireDesktop -or !$CheckRunning -or $managedConfig.launchDesktop -ne $false
$package = $null
$packageQuery = 'available'
try { $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 }
catch { $packageQuery = 'unavailable; use explicit DesktopExe' }
if (!$DesktopExe -and $package) { $DesktopExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
if (!$DesktopExe -and $managedConfig.desktopExe) { $DesktopExe = $managedConfig.desktopExe }
if (!$CliExe) {
    $found = Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($found) { $CliExe = $found.FullName }
}
$report = [ordered]@{ mode = $(if ($CheckRunning) { 'running' } else { 'preflight' }); readOnly = $true }
$report.desktopPackageVersion = $(if ($package) { "$($package.Version)" } else { $null })
$report.packageQuery = $packageQuery
$report.paths = @{ desktop = $DesktopExe; cli = $CliExe; node = $NodeExe; codexHome = $CodexHome }
$report.pathsExist = @{
    desktop = [bool]($DesktopExe -and (Test-Path -LiteralPath $DesktopExe -PathType Leaf))
    cli = [bool]($CliExe -and (Test-Path -LiteralPath $CliExe -PathType Leaf))
    node = [bool](Test-Path -LiteralPath $NodeExe -PathType Leaf)
    codexHome = [bool](Test-Path -LiteralPath $CodexHome -PathType Container)
}
$report.endpointPids = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
$ready = (!$checkDesktop -or $report.pathsExist.desktop) -and $report.pathsExist.cli -and $report.pathsExist.node -and $report.pathsExist.codexHome
if ($ready) {
    $report.nodeVersion = (& $NodeExe --version | Out-String).Trim()
    $nodeVersionExit = $LASTEXITCODE
    $report.cliVersion = (& $CliExe --version | Out-String).Trim()
    $cliVersionExit = $LASTEXITCODE
    $wsOutput = & $NodeExe -e "process.stdout.write(String(typeof WebSocket === 'function'))"
    $report.nodeHasGlobalWebSocket = "$wsOutput" -eq 'true'
    $bundleExit = 0
    if ($report.pathsExist.desktop) {
        $resources = Join-Path (Split-Path -Parent $DesktopExe) 'resources'
        $bundle = Join-Path $resources 'app.asar'
        $raw = & $NodeExe "$PSScriptRoot\inspect.mjs" bundle $bundle
        if ($checkDesktop) { $bundleExit = $LASTEXITCODE }
        $report.bundle = $raw | ConvertFrom-Json
    }
    $ready = $nodeVersionExit -eq 0 -and $cliVersionExit -eq 0 -and $report.nodeHasGlobalWebSocket -and $bundleExit -eq 0
}
# Print only executable identity and parent links. Never print command lines or environment.
$report.processes = @(
    Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ChatGPT.exe','codex.exe') } | ForEach-Object {
        $processOwner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($processOwner.Sid -eq $owner.User.Value) {
            @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; executable = $_.ExecutablePath; started = $_.CreationDate.ToUniversalTime().ToString('o') }
        }
    }
)
if ($CheckRunning -and $ready) {
    $state = if (Test-Path -LiteralPath $managedPath) { Get-Content -LiteralPath $managedPath -Raw | ConvertFrom-Json }
    $expectedPid = if ($state.daemon) { [string]$state.daemon.pid } else { '0' }
    $raw = & $NodeExe "$PSScriptRoot\inspect.mjs" native "ws://127.0.0.1:$Port" $CodexHome $expectedPid
    $nativeExit = $LASTEXITCODE
    $report.native = $raw | ConvertFrom-Json
    $pipeOutput = if ($report.pathsExist.desktop) { & "$PSScriptRoot\find-tools-pipe.ps1" -ExpectedDesktopExe $DesktopExe -OwnerSid $owner.User.Value -BackendPort $Port }
    $pipe = if ($pipeOutput) { $pipeOutput | ConvertFrom-Json } else { $null }
    $report.desktopTools = @{ ownerCheckedPipeFound = [bool]$pipe; desktopBackendConnected = [bool]($pipe -and $pipe.backendConnected); desktopPid = $(if ($pipe) { $pipe.desktopProcessId } else { $null }) }
    $daemonIdentityMatches = $false
    if ($state.daemon) {
        $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.daemon.pid)"
        if ($live) {
            $liveOwner = Invoke-CimMethod -InputObject $live -MethodName GetOwnerSid -ErrorAction SilentlyContinue
            $daemonIdentityMatches = $liveOwner.Sid -eq $owner.User.Value -and $live.CreationDate.ToUniversalTime().ToString('o') -eq $state.daemon.started -and $live.ExecutablePath -eq $state.daemon.executable -and $report.native.endpointOwned
        }
    }
    $report.ownedDaemonEndpointMatches = $daemonIdentityMatches
    $ready = $nativeExit -eq 0 -and $daemonIdentityMatches -and
        (!$checkDesktop -or ($report.desktopTools.ownerCheckedPipeFound -and $report.desktopTools.desktopBackendConnected))
} elseif (!$CheckRunning) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start(); $report.portAvailable = $true }
    catch { $report.portAvailable = $false }
    finally { $listener.Stop() }
    $ready = $ready -and $report.portAvailable
}
$report.ok = [bool]$ready
$report | ConvertTo-Json -Depth 8
if (!$ready) { exit 1 }
