param([Parameter(Mandatory)][int]$ProcessId,[int]$ListeningPort,[int]$PeerProcessId)
$ErrorActionPreference = 'Stop'
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
if (!$process) { throw 'Owned process missing.' }
$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
$result = @{pid=$process.ProcessId;started=$process.CreationDate.ToUniversalTime().ToString('o');ownerSid=$owner.Sid;executable=$process.ExecutablePath}
if ($ListeningPort) {
    $connections = @(Get-NetTCPConnection -OwningProcess $ProcessId -LocalAddress '127.0.0.1' -LocalPort $ListeningPort -ErrorAction SilentlyContinue)
    $result.listening = !!($connections | Where-Object { $_.State -eq 'Listen' })
    # The caller keeps its initialize WebSocket open during this check. Some
    # Windows builds report the listener as undefined State=0, but report its
    # accepted sockets correctly. Do not treat that undefined state as Listen.
    $result.probeConnection = $false
    if ($PeerProcessId) {
        $peers = @(Get-NetTCPConnection -OwningProcess $PeerProcessId -RemoteAddress '127.0.0.1' -RemotePort $ListeningPort -State Established -ErrorAction SilentlyContinue)
        $result.probeConnection = !!($connections | Where-Object {
            $_.State -eq 'Established' -and $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -in @($peers.LocalPort)
        })
    }
    $result.endpointStates = @($connections | ForEach-Object { $_.CimInstanceProperties['State'].Value } | Sort-Object -Unique)
}
$result | ConvertTo-Json -Compress
