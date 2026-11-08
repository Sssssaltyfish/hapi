param([Parameter(Mandatory)][string]$Config)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
$desktop = if ($package) { Join-Path $package.InstallLocation 'app\ChatGPT.exe' } else { $settings.desktopExe }
$cli = Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (!$cli) { throw 'Installed Codex CLI unavailable.' }
foreach ($file in @($desktop,$cli.FullName,$settings.nodeExe)) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Installed runtime unavailable.' } }
$resources = Join-Path (Split-Path -Parent $desktop) 'resources'
if (!(Test-Path -LiteralPath $resources -PathType Container)) { throw 'Desktop resources unavailable.' }
@{desktopExe=$desktop;cliExe=$cli.FullName;nodeExe=$settings.nodeExe;resourcesPath=$resources} | ConvertTo-Json -Compress
