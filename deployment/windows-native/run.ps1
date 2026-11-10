$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -LiteralPath "$root\config.json" -Raw | ConvertFrom-Json
$mutex = [Threading.Mutex]::new($false, "Local\HapiCodexNative-$($config.ownerTag)")
$acquired = $false
try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired=$true }
if (!$acquired) {
    New-Item -ItemType File -Path "$root\state\open" -Force | Out-Null
    exit 0
}
try {
    $delays = @(5,15,30)
    $attempt = 0
    while ($true) {
        $started = [Diagnostics.Stopwatch]::StartNew()
        try {
            $child = Start-Process -FilePath $config.nodeExe -ArgumentList @("`"$root\supervisor.mjs`"") -WorkingDirectory $root -WindowStyle Hidden -PassThru
            $child.WaitForExit()
            $code = $child.ExitCode
        } catch {
            $code = 1
            @{status='failed';daemonReady=$false;toolsPipeReady=$false;desktopBackendConnected=$false;at=[DateTime]::UtcNow.ToString('o');failure=@{reason='supervisor-launch';message=$_.Exception.Message}} |
                ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$root\state\managed.json" -Encoding UTF8
        }
        if ($code -ne 0) {
            # A killed supervisor cannot clear its own ready snapshot.
            try { $state = Get-Content -LiteralPath "$root\state\managed.json" -Raw | ConvertFrom-Json }
            catch { $state = [pscustomobject]@{} }
            $state | Add-Member -Force -NotePropertyMembers @{status='failed';daemonReady=$false;toolsPipeReady=$false;desktopBackendConnected=$false;at=[DateTime]::UtcNow.ToString('o')}
            if (!$state.failure) { $state | Add-Member -Force -NotePropertyName failure -NotePropertyValue @{reason='supervisor-exit';exitCode=$code} }
            $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$root\state\managed.json" -Encoding UTF8
        }
        if ($code -eq 0 -or (Test-Path -LiteralPath "$root\state\stop")) { exit $code }
        if ($started.Elapsed.TotalSeconds -ge 60) { $attempt = 0 }
        if ($attempt -ge $delays.Count) { exit $code }
        $delay = $delays[$attempt++]
        @{at=[DateTime]::UtcNow.ToString('o');event='supervisor-retry';attempt=$attempt;delaySeconds=$delay;exitCode=$code} |
            ConvertTo-Json -Compress | Add-Content -LiteralPath "$root\state\events.jsonl" -Encoding UTF8
        Start-Sleep -Seconds $delay
        if (Test-Path -LiteralPath "$root\state\stop") { exit 0 }
    }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
