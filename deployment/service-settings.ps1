function Read-ServiceSettings([string]$RuntimeRoot) {
    $path = Join-Path $RuntimeRoot 'services.json'
    try { $settings = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Cannot read services.json. Provide a valid UTF-8 JSON file in the Windows runtime directory.' }
    if ($settings -isnot [pscustomobject]) { throw 'services.json must contain a JSON object.' }
    $settings
}

function Get-WslServiceSettings($Settings) {
    $wsl = $Settings.wsl
    if ($wsl -isnot [pscustomobject]) { throw 'Set wsl in services.json.' }
    foreach ($name in @('distribution', 'linuxUser')) {
        $value = $wsl.$name
        if ($value -isnot [string] -or $value -notmatch '^(?!-)[^"\\\x00-\x1f]+\z' -or
            [string]::IsNullOrWhiteSpace($value) -or $value -ne $value.Trim()) {
            throw "Set wsl.$name to a valid name in services.json."
        }
    }
    $units = @()
    if ($wsl.PSObject.Properties['units']) {
        if ($wsl.units -isnot [array]) { throw 'Set wsl.units to an array of unit names in services.json.' }
        foreach ($unit in $wsl.units) {
            if ($unit -isnot [string] -or $unit -notmatch '^[^\s"\x00-\x1f]+\z') {
                throw 'Each entry in wsl.units must be a systemd unit name.'
            }
        }
        $units = $wsl.units
    }
    [pscustomobject]@{ distribution = $wsl.distribution; linuxUser = $wsl.linuxUser; units = $units }
}

function Get-WindowsRunnerSettings($Settings) {
    $runner = $Settings.windowsRunner
    if ($runner -isnot [pscustomobject]) { throw 'Set windowsRunner in services.json.' }
    if ($runner.workspaceRoot -isnot [string] -or $runner.workspaceRoot -notmatch '^(?:[A-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)' -or
        $runner.workspaceRoot -match '["\x00-\x1f]') {
        throw 'Set windowsRunner.workspaceRoot to an absolute Windows directory in services.json.'
    }
    $apiUrl = 'http://127.0.0.1:3006'
    if ($runner.PSObject.Properties['apiUrl']) {
        $uri = $null
        if ($runner.apiUrl -isnot [string] -or ![uri]::TryCreate($runner.apiUrl, [UriKind]::Absolute, [ref]$uri) -or
            $uri.Scheme -notin @('http', 'https')) {
            throw 'Set windowsRunner.apiUrl to an absolute HTTP or HTTPS URL in services.json.'
        }
        $apiUrl = $runner.apiUrl
    }
    $environment = @{}
    if ($runner.PSObject.Properties['environment']) {
        if ($runner.environment -isnot [pscustomobject]) { throw 'Set windowsRunner.environment to a JSON object in services.json.' }
        foreach ($property in $runner.environment.PSObject.Properties) {
            if ($property.Name -notin @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY') -or
                $property.Value -isnot [string] -or $property.Value.Contains([char]0)) {
                throw 'windowsRunner.environment accepts string values for HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY.'
            }
            $environment[$property.Name.ToUpperInvariant()] = $property.Value
        }
    }
    [pscustomobject]@{ workspaceRoot = $runner.workspaceRoot; apiUrl = $apiUrl; environment = $environment }
}

function Set-WindowsRunnerProxy($Environment) {
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
        if ($Environment.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $Environment[$name]) }
    }
    $hasProxy = $env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:ALL_PROXY
    if (!$hasProxy -and !$Environment.ContainsKey('NO_PROXY')) { return }
    $bypass = @($env:NO_PROXY, $Environment['NO_PROXY'])
    if ($hasProxy) { $bypass += 'localhost,127.0.0.1,::1' }
    $entries = @($bypass -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
    $env:NO_PROXY = if ($entries -contains '*') { '*' } else { $entries -join ',' }
}

function ConvertTo-ServiceArgument([string]$Value) {
    '"{0}"' -f ($Value -replace '(\\+)$', '$1$1')
}
