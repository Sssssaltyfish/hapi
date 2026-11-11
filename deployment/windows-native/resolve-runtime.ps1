param([Parameter(Mandatory)][string]$Config)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$package = $null
try { $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 }
catch { }
$desktop = if ($package) { Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
if (!$desktop -or !(Test-Path -LiteralPath $desktop -PathType Leaf)) {
    # A noninteractive token can read the user's registered package location
    # even if the AppX cmdlet is unavailable. Use the configured path as a fallback.
    $repository = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
    $packages = foreach ($key in Get-ChildItem -LiteralPath $repository -ErrorAction SilentlyContinue) {
        if ($key.PSChildName -match '^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_\w+__2p2nqsd0c76g0$') {
            $folder = $key.GetValue('PackageRootFolder')
            if ($folder -and [IO.Path]::GetFileName($folder) -eq $key.PSChildName) {
                @{version=[version]$Matches[1];desktop=(Join-Path $folder 'app\ChatGPT.exe')}
            }
        }
    }
    $desktop = $packages | Sort-Object { $_.version } -Descending | ForEach-Object { $_.desktop } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (!$desktop) { $desktop = $settings.desktopExe }
}
$cli = Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (!$cli) { throw 'Installed Codex CLI unavailable.' }
foreach ($file in @($desktop,$cli.FullName,$settings.nodeExe)) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Installed runtime unavailable.' } }
$resources = Join-Path (Split-Path -Parent $desktop) 'resources'
if (!(Test-Path -LiteralPath $resources -PathType Container)) { throw 'Desktop resources unavailable.' }
@{desktopExe=$desktop;cliExe=$cli.FullName;nodeExe=$settings.nodeExe;resourcesPath=$resources} | ConvertTo-Json -Compress
