param(
    [string]$NodeExe,
    [string]$DesktopExe,
    [string]$CliExe,
    [string]$CodexHome,
    [ValidateRange(1024,65535)][int]$Port = 17844,
    [string]$DeploymentRoot = $PSScriptRoot,
    [switch]$CheckRunning,
    [switch]$LiveOnly,
    [switch]$BackendOnly,
    [switch]$RequireDesktop
)
$ErrorActionPreference = 'Stop'
if ($LiveOnly) { $CheckRunning = $true }
if ($BackendOnly -and (!$CheckRunning -or $RequireDesktop)) {
    throw 'Use -BackendOnly with -CheckRunning or -LiveOnly, without -RequireDesktop.'
}
if ($BackendOnly) { $LiveOnly = $true }
. "$PSScriptRoot\live-backend.ps1"

function Get-DesktopObservation([string]$OwnerSid, [int]$BackendPort, [string]$DesktopHint, $Native, [string]$OwnerTag) {
    $script = "$PSScriptRoot\find-tools-pipe.ps1".Replace("'", "''")
    $command = "& '$script' -OwnerSid '$OwnerSid' -BackendPort $BackendPort -Utf8Output"
    if ($DesktopHint) { $command += " -ExpectedDesktopExe '" + $DesktopHint.Replace("'", "''") + "'" }
    if ($Native.ok) {
        $command += " -BackendPid $($Native.daemon.pid)"
        if ($OwnerTag -match '^[A-Za-z0-9-]+$') {
            $started = ([DateTimeOffset]$Native.supervisor.started).ToString('o')
            $command += " -StableRelayName 'hapi-codex-app-tools-$OwnerTag' -ExpectedRelayPid $($Native.supervisor.pid) -ExpectedRelayStarted '$started'"
        }
    }
    $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $start = [Diagnostics.ProcessStartInfo]::new($powershell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded")
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)

    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $null = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(20000)) {
            if (!$process.HasExited) { $process.Kill() }
            return $null
        }
        if ($process.ExitCode -eq 0) { $stdout.GetAwaiter().GetResult() | ConvertFrom-Json }
    } finally { $process.Dispose() }
}

$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$configPath = Join-Path $DeploymentRoot 'config.json'
$config = $null
$configStatus = 'available'
try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (!$config -or !$config.ownerSid -or !$config.websocketUrl -or !$config.codexHome -or !$config.nodeExe) { $configStatus = 'invalid' }
} catch [System.Management.Automation.ItemNotFoundException] { $configStatus = 'missing' }
catch { $configStatus = 'invalid' }

$url = "ws://127.0.0.1:$Port"
if (!$PSBoundParameters.ContainsKey('Port') -and $configStatus -eq 'available') {
    try {
        $url = [string]$config.websocketUrl
        $Port = ([Uri]$url).Port
        if ($Port -lt 1024) { $configStatus = 'invalid' }
    } catch { $configStatus = 'invalid' }
}
if (!$CodexHome) { $CodexHome = if ($config.codexHome) { $config.codexHome } else { "$env:USERPROFILE\.codex" } }
if (!$NodeExe) {
    $NodeExe = if ($config.nodeExe) { $config.nodeExe }
        else { (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
}
$backend = [pscustomobject]@{
    nodeExe = $(if ($config.nodeExe) { $config.nodeExe } else { $NodeExe })
    cliExe = $(if ($config.cliExe) { $config.cliExe } else { $CliExe })
    ownerSid = $(if ($config.ownerSid) { $config.ownerSid } else { $ownerSid })
    codexHome = $CodexHome; websocketUrl = $url; launchDesktop = $config.launchDesktop
    desktopExe = $config.desktopExe; resourcesPath = $config.resourcesPath
}

$report = [ordered]@{
    mode = $(if ($CheckRunning) { 'running' } else { 'preflight' })
    readOnly = $true; configStatus = $configStatus; url = $url
}
if ($CheckRunning) {
    if ($configStatus -eq 'invalid') { $backend.ownerSid = $null }
    $report.native = Get-CodexLiveBackend -Config $backend -DeploymentRoot $DeploymentRoot -ProbeNodeExe $NodeExe
    $report.snapshot = $report.native.snapshot
    $report.ownedDaemonEndpointMatches = $report.native.ok
    $pipe = $null
    if (!$BackendOnly -and $Port -ge 1024) {
        try {
            $desktopHint = if ($DesktopExe) { $DesktopExe } else { $config.desktopExe }
            $pipe = Get-DesktopObservation $ownerSid $Port $desktopHint $report.native $config.ownerTag
        } catch {}
    }
    $connected = [bool]($report.native.ok -and $pipe.backendConnected)
    $status = if ($BackendOnly) { 'skipped' }
        elseif ($connected) { 'connected' }
        elseif ($pipe.observation -eq 'closed') { 'closed' }
        elseif ($report.native.ok -and $pipe.observation -eq 'available') { 'disconnected' }
        else { 'unobservable' }
    $relay = $pipe.relay
    if (!$relay) {
        $relayStatus = if ($BackendOnly -or $status -eq 'closed') { 'skipped' } else { 'unobservable' }
        $relay = @{status=$relayStatus; serverPid=$null}
    }
    $report.desktopTools = @{
        status = $status
        ownerCheckedPipeFound = [bool]$pipe.pipe
        desktopBackendConnected = $connected
        desktopPid = $pipe.desktopProcessId
        desktop = $(if ($pipe.desktop) { $pipe.desktop | Select-Object pid, started, executable })
        relay = $relay
    }
    $report.ok = [bool]($report.native.ok -and (!$RequireDesktop -or ($pipe.pipe -and $connected)))
    if ($LiveOnly) {
        $report | ConvertTo-Json -Depth 8
        if (!$report.ok) { exit 1 }
        exit 0
    }
}

$package = $null
$packageQuery = 'available'
try { $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1 }
catch { $packageQuery = 'unavailable; use explicit DesktopExe' }
if (!$DesktopExe) {
    $configuredDesktop = $config.desktopExe
    $oldStorePath = $configuredDesktop -match '\\OpenAI\.Codex_\d+\.\d+\.\d+\.\d+_\w+__2p2nqsd0c76g0\\app\\ChatGPT\.exe$'
    if ($configuredDesktop -and !$oldStorePath -and (Test-Path -LiteralPath $configuredDesktop -PathType Leaf)) { $DesktopExe = $configuredDesktop }
    elseif ($package) { $DesktopExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
    else { $DesktopExe = $configuredDesktop }
}
$resources = if ($config.resourcesPath) { $config.resourcesPath } elseif ($DesktopExe) { Join-Path (Split-Path -Parent $DesktopExe) 'resources' }
if (!$CliExe) {
    $CliExe = $config.cliExe
    if (!$CliExe -and $resources) {
        $CliExe = @('codex.exe', 'bin\codex.exe') | ForEach-Object { Join-Path $resources $_ } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (!$CliExe) {
        $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and (Get-Item -LiteralPath $command.Source -ErrorAction SilentlyContinue).Length -gt 0) { $CliExe = $command.Source }
    }
    if (!$CliExe) {
        $cache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenAI\Codex\bin\*\codex.exe'
        $CliExe = (Get-ChildItem -Path $cache -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).FullName
    }
}

$report.desktopPackageVersion = if ($package) { "$($package.Version)" } else { $null }
$report.packageQuery = $packageQuery
$report.paths = @{ desktop = $DesktopExe; cli = $CliExe; node = $NodeExe; codexHome = $CodexHome }
$report.pathsExist = @{
    desktop = [bool]($DesktopExe -and (Test-Path -LiteralPath $DesktopExe -PathType Leaf))
    cli = [bool]($CliExe -and (Test-Path -LiteralPath $CliExe -PathType Leaf))
    node = [bool]($NodeExe -and (Test-Path -LiteralPath $NodeExe -PathType Leaf))
    codexHome = [bool](Test-Path -LiteralPath $CodexHome -PathType Container)
}
$report.endpointPids = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
$nodeVersionExit = 1
$cliVersionExit = 1
$bundleExit = 1
if ($report.pathsExist.node) {
    $report.nodeVersion = (& $NodeExe --version | Out-String).Trim()
    $nodeVersionExit = $LASTEXITCODE
    $wsOutput = & $NodeExe -e "process.stdout.write(String(typeof WebSocket === 'function'))"
    $report.nodeHasGlobalWebSocket = $LASTEXITCODE -eq 0 -and "$wsOutput" -eq 'true'
    if ($report.pathsExist.desktop -and $resources) {
        $raw = & $NodeExe "$PSScriptRoot\inspect.mjs" bundle (Join-Path $resources 'app.asar')
        $bundleExit = $LASTEXITCODE
        $report.bundle = $raw | ConvertFrom-Json
    }
}
if ($report.pathsExist.cli) {
    $report.cliVersion = (& $CliExe --version | Out-String).Trim()
    $cliVersionExit = $LASTEXITCODE
}
# Keep command lines and environment out of the report.
$report.processes = @(
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='codex.exe'" -ErrorAction SilentlyContinue) {
        $sid = (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
        if ($sid -eq $ownerSid -and $process.CreationDate) {
            @{ pid = $process.ProcessId; parentPid = $process.ParentProcessId; executable = $process.ExecutablePath; started = $process.CreationDate.ToUniversalTime().ToString('o') }
        }
    }
)
if (!$CheckRunning) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start(); $report.portAvailable = $true }
    catch { $report.portAvailable = $false }
    finally { $listener.Stop() }
    $report.ok = [bool]($configStatus -ne 'invalid' -and $report.portAvailable -and $report.pathsExist.codexHome -and
        $nodeVersionExit -eq 0 -and $cliVersionExit -eq 0 -and $report.nodeHasGlobalWebSocket -and (!$RequireDesktop -or $bundleExit -eq 0))
}
$report | ConvertTo-Json -Depth 8
if (!$report.ok) { exit 1 }
exit 0
