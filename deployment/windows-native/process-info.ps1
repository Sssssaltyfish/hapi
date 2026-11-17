param(
    [int]$ProcessId,
    [int]$ListeningPort,
    [int]$PeerProcessId,
    [string]$ExpectedSupervisorScript,
    [string]$ExpectedBackendUrl
)
$ErrorActionPreference = 'Stop'

function Get-Identity($Process) {
    if (!$Process -or !$Process.CreationDate) { return $null }
    $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    @{
        pid = $Process.ProcessId
        parentPid = $Process.ParentProcessId
        sessionId = $Process.SessionId
        started = $Process.CreationDate.ToUniversalTime().ToString('o')
        ownerSid = $owner.Sid
        executable = $Process.ExecutablePath
    }
}

$connections = @()
$paired = @()
if ($ListeningPort) {
    $serverFilter = "LocalAddress='127.0.0.1' AND LocalPort=$ListeningPort"
    $filter = $serverFilter
    if ($PeerProcessId) {
        # The caller keeps its initialize WebSocket open. Require both halves
        # of the connection, including the ephemeral client port and its PID.
        $filter = "($serverFilter) OR (OwningProcess=$PeerProcessId AND LocalAddress='127.0.0.1' AND RemoteAddress='127.0.0.1' AND RemotePort=$ListeningPort)"
    }
    $tcp = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter $filter)
    $connections = @($tcp | Where-Object { $_.LocalPort -eq $ListeningPort })
    if ($PeerProcessId) {
        $peerPorts = @($tcp | Where-Object { $_.OwningProcess -eq $PeerProcessId -and $_.RemotePort -eq $ListeningPort -and $_.State -eq 5 } |
            Select-Object -ExpandProperty LocalPort -Unique)
        $paired = @($connections | Where-Object {
            $_.State -eq 5 -and $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -in $peerPorts
        } | Select-Object -ExpandProperty OwningProcess -Unique)
        if (!$ProcessId -and $paired.Count -eq 1) { $ProcessId = $paired[0] }
    }
}
if (!$ProcessId) { throw 'Cannot identify the endpoint owner from the reciprocal connection.' }
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
$result = Get-Identity $process
if (!$result) { throw 'Owned process missing.' }
if ($ListeningPort) {
    $connections = @($connections | Where-Object { $_.OwningProcess -eq $ProcessId })
    $result.listening = [bool]($connections | Where-Object { $_.State -eq 2 })
    $result.probeConnection = $paired.Count -eq 1 -and $paired[0] -eq $ProcessId
    $result.endpointStates = @($connections | Select-Object -ExpandProperty State -Unique | Sort-Object)
}
if ($ExpectedSupervisorScript -or $ExpectedBackendUrl) {
    $parentId = [int]$process.ParentProcessId
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId"
    $result.supervisor = Get-Identity $parent
    # Match the invocation form used by run.ps1. Never emit either command line.
    $firstArgument = '^\s*(?:"[^"]+"|\S+)\s+'
    $script = [regex]::Escape($ExpectedSupervisorScript)
    $url = [regex]::Escape($ExpectedBackendUrl)
    $result.supervisorScriptMatches = [bool]($ExpectedSupervisorScript -and $parent.CommandLine -match
        ($firstArgument + '(?:"' + $script + '"|' + $script + ')\s*$'))
    $result.daemonCommandMatches = [bool]($ExpectedBackendUrl -and $process.CommandLine -match
        ($firstArgument + 'app-server\s+--listen\s+(?:"' + $url + '"|' + $url + ')(?:\s|$)'))
    # Prevent stale parent links and PID reuse during collection from supplying
    # two otherwise valid process identities.
    $live = @(Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId OR ProcessId=$parentId")
    $liveDaemon = $live | Where-Object { $_.ProcessId -eq $ProcessId }
    $liveParent = $live | Where-Object { $_.ProcessId -eq $parentId }
    $result.generationMatches = [bool]($parent -and $parentId -ne $ProcessId -and
        $liveDaemon.ParentProcessId -eq $parentId -and $liveDaemon.CreationDate -eq $process.CreationDate -and
        $liveParent.CreationDate -eq $parent.CreationDate -and $parent.CreationDate -le $process.CreationDate -and
        $parent.SessionId -eq $process.SessionId)
}
$json = $result | ConvertTo-Json -Depth 4 -Compress
# The caller can decode JSON regardless of the PowerShell host's console code page.
[regex]::Replace($json, '[^\x00-\x7F]', { param($match) '\u{0:x4}' -f [int][char]$match.Value[0] })
