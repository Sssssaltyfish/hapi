param([string]$WorkspaceRoot = (Join-Path $env:USERPROFILE 'codex-temp'))

$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$runner = Join-Path $taskRoot 'package\bin\hapi.exe'
$log = Join-Path $taskRoot 'windows-runner.log'
$env:HAPI_HOME = Join-Path $taskRoot 'windows-state'
$env:HAPI_API_URL = 'http://127.0.0.1:3006'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:HTTP_PROXY = 'http://127.0.0.1:10880'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:ALL_PROXY = $env:HTTP_PROXY
$env:HAPI_RUNNER_SUPERVISED = '1'
$codexExe = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -File -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$codexExe -or !(Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Runner or Codex executable is unavailable.' }
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).ProviderPath
$env:PATH = "$($codexExe.DirectoryName);$env:PATH"
Set-Location -LiteralPath $WorkspaceRoot
while ($true) {
    & $runner runner start-sync --workspace-root $WorkspaceRoot *>> $log
    Start-Sleep -Seconds 5
}
