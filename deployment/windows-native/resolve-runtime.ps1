param(
    [Parameter(Mandatory)][string]$Config,
    [switch]$RequireDesktop,
    [switch]$IncludeProxyEnvironment,
    [switch]$Utf8Output
)
$ErrorActionPreference = 'Stop'
if ($Utf8Output) { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) }
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$packageFamily = 'OpenAI.Codex_2p2nqsd0c76g0'
$packagePattern = '^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_\w+__2p2nqsd0c76g0$'

function Get-File([string]$Path) {
    if (!$Path) { return }
    $file = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($file -is [IO.FileInfo]) { $file }
}

function Find-Desktop {
    try {
        foreach ($package in Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | Sort-Object Version -Descending) {
            if ($package.PackageFamilyName -eq $packageFamily -and $package.PackageFullName -match $packagePattern -and
                $package.InstallLocation -and [IO.Path]::GetFileName($package.InstallLocation) -eq $package.PackageFullName) {
                $file = Get-File (Join-Path $package.InstallLocation 'app\ChatGPT.exe')
                if ($file) { return $file }
            }
        }
    } catch {}
    $locations = @(
        # A noninteractive token can often read registration even if AppX is unavailable.
        $repository = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
        foreach ($key in Get-ChildItem -LiteralPath $repository -ErrorAction SilentlyContinue) {
            if ($key.PSChildName -match $packagePattern) {
                $folder = $key.GetValue('PackageRootFolder')
                if ($folder -and [IO.Path]::GetFileName($folder) -eq $key.PSChildName) {
                    @{ version = [version]$Matches[1]; folder = $folder }
                }
            }
        }
    )
    foreach ($location in $locations | Sort-Object { $_.version } -Descending) {
        $file = Get-File (Join-Path $location.folder 'app\ChatGPT.exe')
        if ($file) { return $file }
    }
}

function Get-Version([string]$Value) {
    if ($Value -match '^v?(\d+\.\d+(?:\.\d+){0,2})(?:$|[+\- ])') {
        try { [version]$Matches[1] } catch {}
    }
}

function Get-CompanionCli([string]$Resources) {
    if (!$Resources) { return }
    $direct = Get-File (Join-Path $Resources 'codex.exe')
    if ($direct) { return $direct }
    Get-File (Join-Path $Resources 'bin\codex.exe')
}

$desktop = $null
$resources = $null
try {
    $configuredDesktop = Get-File $settings.desktopExe
    $recordedPackage = $settings.desktopExe -match '[\\/]OpenAI\.Codex_\d+\.\d+\.\d+\.\d+_\w+__2p2nqsd0c76g0[\\/]app[\\/]ChatGPT\.exe$'
    # Legacy configs record the Store path observed during install. Follow updates.
    $desktop = if ($settings.desktopExe -and !$recordedPackage) { $configuredDesktop } else { Find-Desktop }
    if (!$desktop) { $desktop = $configuredDesktop }
    $resourcesCandidate = if ($settings.resourcesPath) { $settings.resourcesPath }
        elseif ($desktop) { Join-Path $desktop.DirectoryName 'resources' }
    if ($resourcesCandidate -and (Test-Path -LiteralPath $resourcesCandidate -PathType Container)) {
        $resources = (Get-Item -LiteralPath $resourcesCandidate).FullName
    }
} catch {
    if ($RequireDesktop) { throw }
}
if ($RequireDesktop -and (!$desktop -or !$resources)) { throw 'Installed Desktop executable or resources unavailable.' }

if ($settings.cliExe) {
    $cli = Get-File $settings.cliExe
    if (!$cli) { throw 'Configured Codex CLI unavailable.' }
} else {
    $cli = $null
    $cacheDirectory = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin' }
    if (!$RequireDesktop -and !$settings.resourcesPath) {
        $packageRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WindowsApps'
        # Query both process types once. Renderer and GPU processes share the
        # Desktop image and must not each trigger a separate WMI query.
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='codex.exe'" -Property Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate -ErrorAction SilentlyContinue)
        $servers = @($processes | Where-Object { $_.Name -eq 'codex.exe' -and $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' })
        foreach ($process in $processes | Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch '(?:^|\s)--type=' } | Sort-Object CreationDate) {
            try {
                $active = Get-File $process.ExecutablePath
                if ($active -and ($active.FullName -eq $desktop.FullName -or (
                    $active.Directory.Name -eq 'app' -and $active.Directory.Parent.Name -match $packagePattern -and
                    $active.Directory.Parent.Parent.FullName -eq $packageRoot))) {
                    $activeResources = Join-Path $active.DirectoryName 'resources'
                    if ($cacheDirectory) {
                        foreach ($child in $servers | Where-Object { $_.ParentProcessId -eq $process.ProcessId }) {
                            $file = Get-File $child.ExecutablePath
                            if ($file -and $file.Directory.Parent.FullName -eq $cacheDirectory) { $cli = $file; break }
                        }
                    }
                    if (!$cli) { $cli = Get-CompanionCli $activeResources }
                    if ($cli) { break }
                }
            } catch {}
        }
        if ($cli -and (Test-Path -LiteralPath $activeResources -PathType Container -ErrorAction SilentlyContinue)) { $resources = $activeResources }
    }
    if (!$cli) { $cli = Get-CompanionCli $resources }
    if (!$cli -and $cacheDirectory) {
        $cache = Join-Path $cacheDirectory '*\codex.exe'
        $cli = Get-ChildItem -Path $cache -File -ErrorAction SilentlyContinue | ForEach-Object {
            $version = Get-Version $_.Directory.Name
            if (!$version) { $version = Get-Version $_.VersionInfo.ProductVersion }
            @{ file = $_; version = $version; timestamp = $_.LastWriteTimeUtc }
        } | Sort-Object @{ Expression = { $_.version }; Descending = $true },
            @{ Expression = { $_.timestamp }; Descending = $true } | ForEach-Object { $_.file } | Select-Object -First 1
    }
    if (!$cli) {
        foreach ($command in Get-Command codex.exe -CommandType Application -All -ErrorAction SilentlyContinue) {
            $candidate = Get-File $command.Source
            # A zero-length WindowsApps alias does not identify an installed CLI.
            if ($candidate -and $candidate.Length -gt 0) { $cli = $candidate; break }
        }
    }
    if (!$cli) { throw 'Installed Codex CLI unavailable.' }
}

if (!(Get-File $settings.nodeExe)) { throw 'Configured Node runtime unavailable.' }
$result = @{desktopExe=$desktop.FullName;cliExe=$cli.FullName;nodeExe=$settings.nodeExe;resourcesPath=$resources}
if ($IncludeProxyEnvironment -and !$settings.PSObject.Properties['proxyEnvironment']) {
    $proxies = @{}
    foreach ($name in 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY') {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (!$value) { $value = [Environment]::GetEnvironmentVariable($name, 'User') }
        if ($value) { $proxies[$name] = $value }
    }
    $result.proxyEnvironment = $proxies
}
$result | ConvertTo-Json -Compress
