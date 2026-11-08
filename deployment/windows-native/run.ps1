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
    $child = Start-Process -FilePath $config.nodeExe -ArgumentList @("`"$root\supervisor.mjs`"") -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $child.WaitForExit()
    exit $child.ExitCode
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
