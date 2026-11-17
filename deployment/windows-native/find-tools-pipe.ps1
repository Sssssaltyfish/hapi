param(
    [string]$ExpectedDesktopExe,
    [Parameter(Mandatory)][string]$OwnerSid,
    [Parameter(Mandatory)][ValidateRange(1,65535)][int]$BackendPort,
    [ValidateRange(1,2147483647)][int]$BackendPid,
    [ValidatePattern('^hapi-codex-app-tools-[A-Za-z0-9-]+$')][string]$StableRelayName,
    [int]$ExpectedRelayPid,
    [DateTimeOffset]$ExpectedRelayStarted,
    [switch]$Utf8Output
)
$ErrorActionPreference = 'Stop'
if ($Utf8Output) { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) }
$result = @{observation='unobservable'; desktopProcessId=$null; backendConnected=$false; pipe=$null; processId=$null; connectionProcessIds=@(); desktop=$null}
# Most headless polls end here without starting a WMI query or loading the pipe API.
$running = [Diagnostics.Process]::GetProcessesByName('ChatGPT')
if ($running.Length -eq 0) {
    $result.observation = 'closed'
    $result | ConvertTo-Json -Compress
    return
}
foreach ($process in $running) { $process.Dispose() }

if (!('CodexDesktopIdentity' -as [type])) {
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CodexDesktopIdentity {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeServerProcessId(SafePipeHandle handle, out uint processId);
}
'@
}

$packagePattern = '^OpenAI\.Codex_\d+\.\d+\.\d+\.\d+_\w+__2p2nqsd0c76g0$'
$packageRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WindowsApps'
$processById = @{}
$desktopById = @{}
$rootById = @{}
$ownerById = @{}

function Get-ProcessEntry([int]$ProcessId) {
    if (!$processById.ContainsKey($ProcessId)) {
        $processById[$ProcessId] = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
    }
    $processById[$ProcessId]
}

function Test-Owner($Entry) {
    $processId = [int]$Entry.ProcessId
    if (!$ownerById.ContainsKey($processId)) {
        $ownerById[$processId] = (Invoke-CimMethod -InputObject $Entry -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -eq $OwnerSid
    }
    $ownerById[$processId]
}

function Test-DesktopPackage($Entry) {
    $file = $Entry.ExecutablePath
    if (!$file) { return $false }
    $app = [IO.Path]::GetDirectoryName($file)
    $folder = [IO.Path]::GetDirectoryName($app)
    $fullName = [IO.Path]::GetFileName($folder)
    if ([IO.Path]::GetFileName($app) -ne 'app' -or $fullName -notmatch $packagePattern) { return $false }

    $process = Get-Process -Id $Entry.ProcessId -ErrorAction SilentlyContinue
    if (!$process) { return $false }
    try {
        $handle = $process.Handle
        # WMI truncates to microseconds, whereas Process.StartTime can include another digit.
        if ($process.HasExited -or [Math]::Abs($process.StartTime.ToUniversalTime().Ticks - $Entry.CreationDate.ToUniversalTime().Ticks) -gt 9) { return $false }
        [uint32]$length = 256
        $name = [Text.StringBuilder]::new([int]$length)
        $status = [CodexDesktopIdentity]::GetPackageFullName($handle,[ref]$length,$name)
        if ($status -eq 0) { return $name.ToString() -eq $fullName }
        # Direct launches can have no process package identity. Windows' protected
        # package store also covers a still-running executable from a previous version.
        return $status -eq 15700 -and [IO.Path]::GetDirectoryName($folder) -eq $packageRoot
    } catch { return $false }
    finally { $process.Dispose() }
}

function Find-DesktopRoot([int]$ProcessId) {
    if ($rootById.ContainsKey($ProcessId)) { return $rootById[$ProcessId] }
    $entry = Get-ProcessEntry $ProcessId
    if (!$entry -or !(Test-Owner $entry)) { return }
    $parent = Get-ProcessEntry $entry.ParentProcessId
    if (!$parent -or $parent.SessionId -ne $entry.SessionId -or $parent.CreationDate -ge $entry.CreationDate) { return }
    $desktopId = Find-DesktopRoot $parent.ProcessId
    $rootById[$ProcessId] = $desktopId
    $desktopId
}

function Get-StableRelayObservation {
    $status = @{ status='unobservable'; serverPid=$null }
    $relay = [IO.Pipes.NamedPipeClientStream]::new('.', $StableRelayName, [IO.Pipes.PipeDirection]::InOut)
    $server = $null
    try {
        # Open and close the channel without sending any tool messages.
        $relay.Connect(200)
        [uint32]$serverPid = 0
        if (![CodexDesktopIdentity]::GetNamedPipeServerProcessId($relay.SafePipeHandle,[ref]$serverPid)) { return $status }
        $status.serverPid = $serverPid
        if ($serverPid -ne $ExpectedRelayPid) { $status.status = 'other-process'; return $status }
        $server = [Diagnostics.Process]::GetProcessById($serverPid)
        $creationTicks = $server.StartTime.ToUniversalTime().Ticks
        if (!$server.HasExited) {
            $status.status = if ([Math]::Abs($creationTicks - $ExpectedRelayStarted.UtcDateTime.Ticks) -le 9) { 'verified' } else { 'other-process' }
        }
    } catch [TimeoutException] { $status.status = 'unreachable' }
    catch {}
    finally {
        $relay.Dispose()
        if ($server) { $server.Dispose() }
    }
    $status
}

$roots = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine -notmatch '--type=|--user-data-dir|--profile-directory' -and
    (Test-DesktopPackage $_) -and (Test-Owner $_)
} | Sort-Object @{ Expression = { $_.ExecutablePath -eq $ExpectedDesktopExe }; Descending = $true },
    @{ Expression = { $_.CreationDate }; Descending = $true })
foreach ($entry in $roots) {
    $processId = [int]$entry.ProcessId
    $processById[$processId] = $entry
    $rootById[$processId] = $processId
    $identity = @{pid=$processId;started=$entry.CreationDate.ToUniversalTime().ToString('o');ownerSid=$OwnerSid;executable=$entry.ExecutablePath}
    $desktopById[$processId] = @{observation='available'; desktopProcessId=$processId; backendConnected=$false; pipe=$null; processId=$null; connectionProcessIds=@(); desktop=$identity}
}
if ($roots.Count -eq 0) {
    $result | ConvertTo-Json -Compress
    return
}

$loopback = @('127.0.0.1', '::ffff:127.0.0.1')
$tcp = @()
try {
    $filter = "State=5 AND (LocalPort=$BackendPort OR RemotePort=$BackendPort)"
    $tcp = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter $filter)
} catch {
    foreach ($candidate in $desktopById.Values) { $candidate.observation = 'unobservable' }
}
$clientConnections = @($tcp | Where-Object {
    $_.RemotePort -eq $BackendPort -and $_.LocalAddress -in $loopback -and $_.RemoteAddress -in $loopback
})
if ($clientConnections.Count -gt 0) {
    $serverConnections = $tcp | Where-Object {
        $_.LocalPort -eq $BackendPort -and $_.LocalAddress -eq '127.0.0.1' -and $_.RemoteAddress -eq '127.0.0.1' -and
            (!$BackendPid -or $_.OwningProcess -eq $BackendPid)
    }
    $peerPorts = [Collections.Generic.HashSet[int]]::new()
    foreach ($server in $serverConnections) {
        $backend = Get-ProcessEntry $server.OwningProcess
        $matchesBackend = if ($BackendPid) { $backend.ProcessId -eq $BackendPid } else { [IO.Path]::GetFileName($backend.ExecutablePath) -eq 'codex.exe' }
        if ($backend -and $matchesBackend -and (Test-Owner $backend)) {
            $null = $peerPorts.Add([int]$server.RemotePort)
        }
    }
    foreach ($client in $clientConnections) {
        if (!$peerPorts.Contains([int]$client.LocalPort)) { continue }
        $desktopId = Find-DesktopRoot $client.OwningProcess
        if (!$desktopId) { continue }
        $candidate = $desktopById[$desktopId]
        $candidate.backendConnected = $true
        if ($client.OwningProcess -notin $candidate.connectionProcessIds) { $candidate.connectionProcessIds += @($client.OwningProcess) }
    }
}

$pipeNames = try { [IO.Directory]::GetFiles('\\.\pipe\') } catch { @() }
foreach ($name in $pipeNames) {
    $leaf = $name.Substring($name.LastIndexOf('\')+1)
    if ($leaf -notmatch '^codex-app-tools-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { continue }
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $leaf, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None)
    try {
        $pipe.Connect(100)
        [uint32]$serverProcessId = 0
        if (![CodexDesktopIdentity]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$serverProcessId)) { continue }
        $desktopId = Find-DesktopRoot $serverProcessId
        if (!$desktopId) { continue }
        $candidate = $desktopById[$desktopId]
        $candidate.pipe = $name
        $candidate.processId = $serverProcessId
        if ($candidate.backendConnected) { break }
    } catch {} finally { $pipe.Dispose() }
}

$candidateOrder = @(
    @{ Expression = { $_.backendConnected }; Descending = $true }
    @{ Expression = { !!$_.pipe }; Descending = $true }
)
$result = $roots | ForEach-Object { $desktopById[[int]$_.ProcessId] } | Sort-Object -Property $candidateOrder | Select-Object -First 1
if ($result.pipe -and $StableRelayName -and $ExpectedRelayPid -and $ExpectedRelayStarted) {
    $result.relay = Get-StableRelayObservation
}
$result | ConvertTo-Json -Depth 3 -Compress
