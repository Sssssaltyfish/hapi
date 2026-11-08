$ErrorActionPreference = 'Stop'
$urls = @(
    'https://seia.tailc9c975.ts.net/',
    'https://seia.tailc9c975.ts.net:8444/health',
    'http://127.0.0.1:18080/editor/',
    'http://127.0.0.1:18080/shell/',
    'http://127.0.0.1:3000/',
    'http://127.0.0.1:18082/health'
)
$samples = @()
for ($index = 0; $index -lt 8; $index++) {
    $row = [ordered]@{at=[DateTime]::UtcNow.ToString('o');status=@{}}
    foreach ($url in $urls) {
        $request = [Net.HttpWebRequest]::Create($url)
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 3000
        try {
            $response = $request.GetResponse()
            try { $row.status[$url] = [int]$response.StatusCode } finally { $response.Dispose() }
        } catch [Net.WebException] {
            if ($_.Exception.Response) {
                $row.status[$url] = [int]$_.Exception.Response.StatusCode
                $_.Exception.Response.Dispose()
            } else { $row.status[$url] = $_.Exception.Status.ToString() }
        }
    }
    $samples += [pscustomobject]$row
    if ($index -lt 7) { Start-Sleep -Seconds 10 }
}
$result = [ordered]@{samples=$samples;windowsWslClients=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'wsl.exe' } | Select-Object ProcessId,ParentProcessId,CreationDate);keeper=[string](Get-ScheduledTask -TaskName 'Seia-WSL-Services').State}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$PSScriptRoot\services-stability.json" -Encoding utf8
$result | ConvertTo-Json -Depth 6
