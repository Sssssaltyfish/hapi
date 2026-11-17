function Get-CodexSnapshotStatus([string]$DeploymentRoot, $Config, $Live) {
    $path = Join-Path $DeploymentRoot 'state\managed.json'
    try {
        $state = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        return @{ status = 'missing'; at = $null }
    } catch {
        return @{ status = 'unreadable'; at = $null }
    }
    if (!$state -or !$state.status -or !$state.at) { return @{ status = 'unreadable'; at = $null } }
    try { $at = ([DateTimeOffset]$state.at).UtcDateTime }
    catch { return @{ status = 'unreadable'; at = $null } }

    $current = $Live.ok -and $state.status -eq 'ready' -and $state.daemonReady -eq $true -and
        $state.url -eq $Config.websocketUrl -and ($state.launchDesktop -ne $false) -eq ($Config.launchDesktop -ne $false)
    if ($current) {
        foreach ($role in @('daemon', 'supervisor')) {
            $actual = $Live.$role
            $saved = $state.$role
            try {
                if ($actual.pid -ne $saved.pid -or $actual.executable -ne $saved.executable -or
                    $actual.ownerSid -ne $saved.ownerSid -or !$saved.started -or
                    ([DateTimeOffset]$actual.started).UtcDateTime -ne ([DateTimeOffset]$saved.started).UtcDateTime) { $current = $false }
            } catch { $current = $false }
        }
    }
    @{ status = $(if ($current) { 'current' } else { 'stale' }); at = $at.ToString('o') }
}

function Test-CodexBackendExecutable([string]$Executable, $Config) {
    if (!$Executable) { return $false }
    $cli = [IO.Path]::GetFullPath($Executable)
    if ([IO.Path]::GetFileName($cli) -ne 'codex.exe') { return $false }

    # A newer installed build can replace the next launch candidate while the
    # current daemon is still healthy. Check its installation location directly.
    $directory = Split-Path -Parent $cli
    $cache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenAI\Codex\bin'
    if ((Split-Path -Parent $directory) -eq $cache) { return $true }
    $configuredResources = $Config.resourcesPath
    if (!$configuredResources -and $Config.desktopExe) {
        $configuredResources = Join-Path (Split-Path -Parent $Config.desktopExe) 'resources'
    }
    if ($configuredResources) {
        $configuredResources = [IO.Path]::GetFullPath($configuredResources)
        if ($directory -eq $configuredResources -or $directory -eq (Join-Path $configuredResources 'bin')) { return $true }
    }
    $resources = if ([IO.Path]::GetFileName($directory) -eq 'bin') { Split-Path -Parent $directory } else { $directory }
    if ($resources -match '\\(?<package>OpenAI\.Codex_\d+\.\d+\.\d+\.\d+_\w+__2p2nqsd0c76g0)\\app\\resources$') {
        $package = $Matches.package
        $packageDirectory = Split-Path -Parent (Split-Path -Parent $resources)
        $repository = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
        $registration = Get-ItemProperty -LiteralPath (Join-Path $repository $package) -Name PackageRootFolder -ErrorAction SilentlyContinue
        $systemPackages = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WindowsApps'
        if ($packageDirectory -eq $registration.PackageRootFolder -or (Split-Path -Parent $packageDirectory) -eq $systemPackages) { return $true }
    }

    # The resolver also supports a real standalone application on PATH.
    $command = Get-Command codex.exe -CommandType Application -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -eq $cli } | Select-Object -First 1
    return [bool]($command -and (Get-Item -LiteralPath $cli -ErrorAction SilentlyContinue).Length -gt 0)
}

function Get-CodexLiveBackend {
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$DeploymentRoot,
        [string]$ProbeNodeExe = $Config.nodeExe,
        [DateTime]$StartedAfter = [DateTime]::MinValue
    )
    $result = [ordered]@{
        ok = $false; initialized = $false; homeMatches = $false; endpointOwned = $false
        code = 'INVALID_CONFIGURATION'; url = $Config.websocketUrl
        platformFamily = $null; daemon = $null; supervisor = $null
    }
    try {
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if (!$Config.nodeExe -or !$ProbeNodeExe -or !$Config.codexHome -or !$Config.websocketUrl -or !$Config.ownerSid) { return $result }
        if ($Config.ownerSid -ne $currentSid) { $result.code = 'CONFIGURATION_OWNER_MISMATCH'; return $result }

        $url = [Uri]$Config.websocketUrl
        if ($url.Scheme -cne 'ws' -or $url.Host -ne '127.0.0.1' -or $url.Port -lt 1024 -or $url.AbsolutePath -ne '/' -or
            $url.UserInfo -or $url.Query -or $url.Fragment) { return $result }
        if (!(Test-Path -LiteralPath $ProbeNodeExe -PathType Leaf)) { $result.code = 'NODE_NOT_FOUND'; return $result }

        $root = [IO.Path]::GetFullPath($DeploymentRoot)
        $supervisorScript = Join-Path $root 'supervisor.mjs'
        $arguments = @('native', $result.url, $Config.codexHome, '0', $supervisorScript, $Config.nodeExe)
        if ($Config.cliExe) { $arguments += $Config.cliExe }
        $raw = & $ProbeNodeExe "$PSScriptRoot\inspect.mjs" @arguments
        $probe = $raw | ConvertFrom-Json
        if (!$probe.code) { $result.code = 'PROBE_FAILED'; return $result }
        foreach ($key in @('code', 'initialized', 'homeMatches', 'endpointOwned', 'platformFamily')) {
            if ($null -ne $probe.$key) { $result[$key] = $probe.$key }
        }
        if (!$probe.ok) { return $result }

        $endpoint = $probe.endpoint
        $supervisor = $endpoint.supervisor
        $result.checks = @{
            daemonOwner = $endpoint.ownerSid -eq $Config.ownerSid
            daemonExecutable = $(if ($Config.cliExe) { $endpoint.daemonExecutableMatches -eq $true }
                else { Test-CodexBackendExecutable $endpoint.executable $Config })
            daemonCommand = $endpoint.daemonCommandMatches -eq $true
            supervisorOwner = $supervisor.ownerSid -eq $Config.ownerSid
            supervisorExecutable = $endpoint.supervisorExecutableMatches -eq $true
            supervisorScript = $endpoint.supervisorScriptMatches -eq $true
            generation = $endpoint.generationMatches -eq $true
        }
        if ($false -in $result.checks.Values) { $result.code = 'MANAGED_IDENTITY_MISMATCH'; return $result }
        if (([DateTimeOffset]$supervisor.started).UtcDateTime -lt $StartedAfter.ToUniversalTime()) {
            $result.code = 'SUPERVISOR_PREDATES_START'; return $result
        }
        $result.daemon = $endpoint | Select-Object pid, parentPid, sessionId, started, ownerSid, executable
        $result.supervisor = $supervisor
        $result.ok = $true
    } catch {
        $result.code = 'PROBE_FAILED'
    } finally {
        $result.snapshot = Get-CodexSnapshotStatus $DeploymentRoot $Config $result
    }
    $result
}
