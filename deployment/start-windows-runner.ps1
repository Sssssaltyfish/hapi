$ErrorActionPreference = 'Stop'
$taskRoot = 'C:\Users\Igna\codex-temp\hapi-deployment'
$env:HAPI_HOME = Join-Path $taskRoot 'windows-state'
$env:HAPI_API_URL = 'http://127.0.0.1:3006'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:HTTP_PROXY = 'http://127.0.0.1:10880'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:ALL_PROXY = $env:HTTP_PROXY
$env:HAPI_RUNNER_SUPERVISED = '1'
$codexExe = Get-ChildItem 'C:\Users\Igna\AppData\Local\OpenAI\Codex\bin' -Filter codex.exe -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$env:PATH = "$($codexExe.DirectoryName);$env:PATH"
Set-Location 'C:\Users\Igna\codex-temp'
while ($true) {
    & "$taskRoot\package\bin\hapi.exe" runner start-sync --workspace-root 'C:\Users\Igna\codex-temp' *>> "$taskRoot\windows-runner.log"
    Start-Sleep -Seconds 5
}
