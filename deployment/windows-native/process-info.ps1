param([Parameter(Mandatory)][int]$ProcessId,[int]$ListeningPort)
$ErrorActionPreference = 'Stop'
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
if (!$process) { throw 'Owned process missing.' }
$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
$result = @{pid=$process.ProcessId;started=$process.CreationDate.ToUniversalTime().ToString('o');ownerSid=$owner.Sid;executable=$process.ExecutablePath}
if ($ListeningPort) { $result.listening=!!(Get-NetTCPConnection -OwningProcess $ProcessId -LocalPort $ListeningPort -State Listen -ErrorAction SilentlyContinue) }
$result | ConvertTo-Json -Compress
