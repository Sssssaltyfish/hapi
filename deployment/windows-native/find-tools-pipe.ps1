param([Parameter(Mandatory)][string]$ExpectedDesktopExe,[Parameter(Mandatory)][string]$OwnerSid,[Parameter(Mandatory)][int]$BackendPort)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
public static class PipeOwner {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle handle, out uint processId);
}
'@
$processes = @(Get-CimInstance Win32_Process)
$owned = [Collections.Generic.HashSet[int]]::new()
$mainByDescendant = @{}
foreach ($process in $processes) {
    if ($process.ExecutablePath -ne $ExpectedDesktopExe -or $process.CommandLine -match '--type=|--user-data-dir|--profile-directory') { continue }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($owner.Sid -ne $OwnerSid) { continue }
    $owned.Add([int]$process.ProcessId) | Out-Null
    $mainByDescendant[[int]$process.ProcessId] = [int]$process.ProcessId
}
do {
    $added = $false
    foreach ($process in $processes) {
        if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) {
            $mainByDescendant[[int]$process.ProcessId] = $mainByDescendant[[int]$process.ParentProcessId]
            $added = $true
        }
    }
} while ($added)
$found = $null
foreach ($name in [IO.Directory]::GetFiles('\\.\pipe\')) {
    $leaf = $name.Substring($name.LastIndexOf('\')+1)
    if ($leaf -notmatch '^codex-app-tools-[0-9a-f-]{36}$') { continue }
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $leaf, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None)
    try {
        $pipe.Connect(100)
        [uint32]$serverProcessId = 0
        if ([PipeOwner]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$serverProcessId) -and $owned.Contains([int]$serverProcessId)) {
            $desktopRoot = $mainByDescendant[[int]$serverProcessId]
            $connections = @(Get-NetTCPConnection -RemotePort $BackendPort -State Established -ErrorAction SilentlyContinue | Where-Object { $mainByDescendant[[int]$_.OwningProcess] -eq $desktopRoot -and $_.RemoteAddress -in @('127.0.0.1','::1','::ffff:127.0.0.1') })
            $candidate = @{pipe=$name;processId=$serverProcessId;desktopProcessId=$desktopRoot;backendConnected=($connections.Count -gt 0);connectionProcessIds=@($connections.OwningProcess)}
            if ($candidate.backendConnected) { $found = $candidate; break }
            if (!$found) { $found = $candidate }
        }
    } catch {} finally { $pipe.Dispose() }
}
if ($found) { $found | ConvertTo-Json -Compress }
