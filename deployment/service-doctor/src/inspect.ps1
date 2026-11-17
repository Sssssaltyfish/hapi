$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$runtime = $env:HAPI_DOCTOR_RUNTIME
$selection = @($env:HAPI_DOCTOR_COMPONENTS -split ',' | Where-Object { $_ })
$info = $env:HAPI_DOCTOR_MODE -eq 'info'
$showProcesses = $env:HAPI_DOCTOR_MODE -in @('info', 'watch')
$checks = [Collections.Generic.List[object]]::new()
$inventory = [ordered]@{}
$liveProcesses = [ordered]@{}
$systemDirectory = [Environment]::SystemDirectory
$powershell = Join-Path $systemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
$wslExe = Join-Path $systemDirectory 'wsl.exe'

function Test-Selected([string]$Component) {
    !$selection.Count -or $Component -in $selection
}

function Add-Check([string]$Component, [string]$Check, [string]$Status, [string]$Detail, [string]$Action = '') {
    $row = [ordered]@{ component = $Component; check = $Check; status = $Status; detail = $Detail }
    if ($Action) { $row.action = $Action }
    $checks.Add($row)
}

function Add-Inventory([string]$Label, [string]$Value) {
    if ($info -and $Value -and $Value -notmatch '[\x00-\x1F\x7F-\x9F]') {
        $inventory[$Label] = $Value
    }
}

function Add-LiveProcess([string]$Role, $Record) {
    if (!$showProcesses -or !$Record) { return }
    $processId = 0L
    $started = [DateTimeOffset]::MinValue
    if ([long]::TryParse([string]$Record.pid, [ref]$processId) -and $processId -gt 0 -and
        $processId -le [uint32]::MaxValue -and [DateTimeOffset]::TryParseExact([string]$Record.started, 'o',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$started)) {
        $liveProcesses[$Role] = [ordered]@{ pid = $processId; startedAtUtc = $started.UtcDateTime.ToString('o') }
    }
}

function Read-PrivateJson([string]$Path) {
    try {
        $data = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
        if ($data -isnot [pscustomobject]) { return @{ status = 'invalid' } }
        @{ status = 'ok'; data = $data }
    } catch [System.Management.Automation.ItemNotFoundException] {
        @{ status = 'absent' }
    } catch {
        @{ status = 'unavailable' }
    }
}

# ProcessStartInfo in Windows PowerShell 5.1 needs Windows argument quoting.
function Quote-Argument([string]$Value) {
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Run-Tool([string]$File, [string[]]$Arguments, [int]$Milliseconds) {
    $process = [Diagnostics.Process]::new()
    $stdout = [IO.MemoryStream]::new()
    $stderr = [IO.MemoryStream]::new()
    $process.StartInfo.FileName = $File
    $process.StartInfo.Arguments = ($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        $null = $process.Start()
        $read = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errors = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (!$process.WaitForExit($Milliseconds)) {
            try { $process.Kill() } catch {}
            return @{ status = 'timeout' }
        }
        if (!$read.Wait(1000) -or !$errors.Wait(1000)) { return @{ status = 'timeout' } }
        $bytes = $stdout.ToArray()
        $encoding = if ($bytes -contains 0) { [Text.Encoding]::Unicode } else { [Text.Encoding]::UTF8 }
        @{ status = 'ok'; code = $process.ExitCode; output = $encoding.GetString($bytes).TrimStart([char]0xFEFF) }
    } catch {
        @{ status = 'unavailable' }
    } finally {
        $process.Dispose()
        $stdout.Dispose()
        $stderr.Dispose()
    }
}

function Get-JsonOutput($Run) {
    if ($Run.status -eq 'ok' -and $Run.output) {
        try { $Run.output | ConvertFrom-Json } catch {}
    }
}

function Get-TaskFolder {
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $service.GetFolder('\')
    } catch {}
}

function Find-Task($Folder, [string]$Name) {
    if (!$Folder) { return @{ status = 'unavailable' } }
    try {
        $task = $Folder.GetTask($Name)
        @{ status = 'ok'; task = $task }
    } catch {
        $reason = $_.Exception.GetBaseException().HResult
        if ($reason -in @(-2147024894, -2147024893)) { return @{ status = 'absent' } }
        @{ status = 'unavailable' }
    }
}

function Check-Task([string]$Component, [string]$Name, [string]$Entry, $Found, [bool]$Expected, [bool]$Continuous) {
    if ($Expected -or $Found.status -eq 'ok') { Add-Inventory "$Component task" $Name }
    if ($Found.status -eq 'absent') {
        if ($Expected) {
            Add-Check $Component 'scheduled task' 'down' 'The managed task is missing.' 'Review the owner account and task registration in Task Scheduler.'
        } else { Add-Check $Component 'scheduled task' 'optional' 'No task is installed for this component.' }
        return
    }
    if ($Found.status -ne 'ok') {
        Add-Check $Component 'scheduled task' 'unavailable' 'Task Scheduler did not provide the task state.' 'Run the doctor from the deployment owner account.'
        return
    }
    $task = $Found.task
    $definition = $task.Definition
    $entryPath = Join-Path $runtime $Entry
    $referencesEntry = $false
    foreach ($action in $definition.Actions) {
        $arguments = [string]$action.Arguments
        $referencesEntry = $referencesEntry -or $arguments -match ('(?:^|\s)"?' + [regex]::Escape($entryPath) + '"?(?=\s|$)')
    }
    if (!$referencesEntry) {
        Add-Check $Component 'scheduled task' 'down' 'The registered action points outside the selected runtime or uses an unrecognized entry.' 'In Task Scheduler, compare the task action with this runtime (see info).'
        return
    }
    if (!$task.Enabled -or $task.State -eq 1) {
        Add-Check $Component 'scheduled task' 'down' 'The managed task is disabled.' 'Review the task state and logon trigger in Task Scheduler.'
        return
    }
    $state = switch ([int]$task.State) { 2 {'queued'} 3 {'ready'} 4 {'running'} default {'unknown'} }
    $logon = switch ([int]$definition.Principal.LogonType) { 3 {'interactive'} 2 {'S4U'} default {'other'} }
    Add-Inventory "$component task logon" $logon
    if ($state -eq 'unknown') {
        Add-Check $Component 'scheduled task' 'unavailable' 'Task Scheduler returned an unknown state.'
    } elseif ($Continuous -and $state -ne 'running') {
        Add-Check $Component 'scheduled task' 'down' "The managed task is $state." 'Review recent task results and the component log.'
    } else {
        Add-Check $Component 'scheduled task' 'healthy' "The managed task is $state ($logon logon)."
    }
}

function Get-WebUri([string]$Value) {
    $uri = $null
    if ([uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -in @('http', 'https') -and $uri.Host) {
        $uri
    }
}

function Get-Authority([uri]$Uri) {
    '{0}://{1}:{2}' -f $Uri.Scheme, $Uri.Host, $Uri.Port
}

function Probe-Web([uri]$Uri, [string]$Kind, [switch]$UseGet) {
    try {
        $builder = [UriBuilder]::new($Uri)
        $builder.UserName = ''
        $builder.Password = ''
        $builder.Query = ''
        $builder.Fragment = ''
        $request = [Net.HttpWebRequest]::Create($builder.Uri)
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 2500
        $request.ReadWriteTimeout = 2500
        $request.KeepAlive = $false
        $request.Method = if ($UseGet -or $Kind -eq 'hub') { 'GET' } elseif ($Kind -eq 'runner') { 'POST' } else { 'HEAD' }
        if ($Kind -eq 'runner') {
            $request.ContentType = 'application/json'
            $request.ContentLength = 2
            $requestStream = $request.GetRequestStream()
            try { $requestStream.Write([byte[]]@(123,125), 0, 2) } finally { $requestStream.Dispose() }
        }
        try { $response = $request.GetResponse() }
        catch [Net.WebException] { $response = $_.Exception.Response; if (!$response) { return @{ status = 'unreachable' } } }
        try {
            $code = [int]$response.StatusCode
            $healthy = $code -ge 200 -and $code -lt 400 -or $code -in @(401, 403)
            if ($Kind -in @('runner', 'hub')) { $healthy = $code -eq 200 }
            if ($healthy -and $Kind -eq 'hub') {
                $stream = $response.GetResponseStream()
                try {
                    $buffer = New-Object byte[] 4096
                    $read = 0
                    while ($read -lt $buffer.Length) {
                        $length = $stream.Read($buffer, $read, $buffer.Length - $read)
                        if (!$length) { break }
                        $read += $length
                    }
                    $body = [Text.Encoding]::UTF8.GetString($buffer, 0, $read) | ConvertFrom-Json
                    $healthy = $body.status -ceq 'ok' -and $null -ne $body.protocolVersion
                } catch { $healthy = $false }
                finally { $stream.Dispose() }
            }
            @{ status = $(if ($healthy) { 'healthy' } else { 'unexpected' }); code = $code }
        } finally { $response.Dispose() }
    } catch { @{ status = 'unreachable' } }
}

function Probe-Tcp([uri]$Uri) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync($Uri.DnsSafeHost, $Uri.Port)
        $connection.Wait(2500) -and $client.Connected
    } catch { $false }
    finally { $client.Dispose() }
}

function Check-Web([string]$Component, [string]$Label, [uri]$Uri, [string]$Kind, [string]$Action) {
    $probe = Probe-Web $Uri $Kind
    if ($Kind -eq 'web' -and $probe.code -in @(405,501)) {
        $probe = Probe-Web $Uri $Kind -UseGet
    }
    if ($probe.status -eq 'healthy') {
        $message = if ($Kind -eq 'hub') { 'HAPI health response verified (HTTP 200).' } else { "Endpoint responded with HTTP $($probe.code)." }
        Add-Check $Component $Label 'healthy' $message
    } elseif ($probe.status -eq 'unexpected') {
        Add-Check $Component $Label 'down' "Unexpected response (HTTP $($probe.code))." $Action
    } else {
        Add-Check $Component $Label 'down' 'Endpoint was unreachable or timed out.' $Action
    }
}

function Check-Runner($Services, $Folder) {
    $runner = $Services.data.windowsRunner
    $taskName = 'HAPI-Windows-Runner'
    $found = Find-Task $Folder $taskName
    Check-Task 'runner' $taskName 'start-windows-runner.ps1' $found ([bool]$runner) $true
    if (!$runner -and $found.status -ne 'ok') { return }
    $runnerExe = Join-Path $runtime 'package\bin\hapi.exe'
    $statePath = Join-Path $runtime 'windows-state\runner.state.json'
    Add-Inventory 'runner executable' $runnerExe
    Add-Inventory 'runner workspace' $runner.workspaceRoot
    Add-Inventory 'runner log' (Join-Path $runtime 'windows-runner.log')
    Add-Inventory 'runner state' $statePath
    $state = Read-PrivateJson $statePath
    $runnerPid = 0
    $port = 0
    if ($state.status -ne 'ok' -or ![int]::TryParse([string]$state.data.pid, [ref]$runnerPid) -or $runnerPid -lt 1 -or
        ![int]::TryParse([string]$state.data.httpPort, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        $status = if ($state.status -eq 'unavailable') { 'unavailable' } else { 'down' }
        Add-Check 'runner' 'control endpoint' $status 'Current runner PID and port could not be read.' 'Review windows-runner.log and ensure the managed runner can write its state.'
        return
    }
    Add-Inventory 'runner control authority' "http://127.0.0.1:$port"
    $process = Get-Process -Id $runnerPid -ErrorAction SilentlyContinue
    if (!$process -or $process.ProcessName -ne 'hapi' -or ($process.Path -and $process.Path -ne $runnerExe)) {
        Add-Check 'runner' 'control endpoint' 'down' 'Runner state points to a missing or unexpected process.' 'Review windows-runner.log for exited workers or stale state.'
        return
    }
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $port -ErrorAction Stop | Where-Object {
            $_.OwningProcess -eq $runnerPid -and $_.LocalAddress -eq '127.0.0.1' -and $_.RemotePort -eq 0
        })
    } catch [Microsoft.Management.Infrastructure.CimException] {
        if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { $listeners = @() }
        else {
            Add-Check 'runner' 'control endpoint' 'unavailable' 'Windows did not provide TCP listener ownership.' 'Query as the deployment owner.'
            return
        }
    }
    if (!$listeners.Count) {
        Add-Check 'runner' 'control endpoint' 'down' 'The recorded runner does not own its loopback listener.' 'Review windows-runner.log and the scheduled task.'
        return
    }
    Check-Web 'runner' 'control endpoint' ([uri]"http://127.0.0.1:$port/list") 'runner' 'Review the running worker and windows-runner.log.'
}

function Get-InspectorParameters([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    $ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }
}

function Find-PortableInspector {
    $directory = Split-Path -Parent $env:HAPI_DOCTOR_EXECUTABLE
    if (!$directory) { return }
    $nativeDirectory = Join-Path $directory 'windows-native'
    $candidate = Join-Path $nativeDirectory 'inspect.ps1'
    $parameters = @(Get-InspectorParameters $candidate)
    if ('LiveOnly' -in $parameters -and 'BackendOnly' -in $parameters -and 'DeploymentRoot' -in $parameters -and
        (Test-Path -LiteralPath (Join-Path $nativeDirectory 'live-backend.ps1') -PathType Leaf)) {
        $candidate
    }
}

function Read-StoreSetting([string]$Name) {
    try {
        foreach ($scope in @('User', 'Machine')) {
            $value = [Environment]::GetEnvironmentVariable($Name, $scope)
            if ($value) { return @{ status = 'set'; scope = $scope.ToLowerInvariant(); value = $value } }
        }
        @{ status = 'unset' }
    } catch { @{ status = 'unavailable' } }
}

function Check-StoreRouting([uri]$NativeUri, [bool]$DesktopConfigured, $ForceCli, $Endpoint) {
    if ($ForceCli.status -eq 'unavailable') {
        Add-Check 'desktop' 'Store FORCE_CLI' 'unavailable' 'Windows did not provide the stored CLI override.' 'Review CODEX_APP_SERVER_FORCE_CLI in Windows Environment Variables.'
    } elseif ($ForceCli.value -ceq '1') {
        $scope = if ($ForceCli.scope -eq 'user') { 'user' } else { 'machine' }
        Add-Check 'desktop' 'Store FORCE_CLI' 'down' "The stored $scope setting forces a normal Store launch to use CLI mode." 'Review CODEX_APP_SERVER_FORCE_CLI in Windows Environment Variables before reopening Desktop.'
    } else {
        Add-Check 'desktop' 'Store FORCE_CLI' 'healthy' 'The stored Windows settings allow WebSocket routing.'
    }

    if (!$NativeUri -or $Endpoint.status -eq 'unavailable') {
        Add-Check 'desktop' 'Store endpoint' 'unavailable' 'The expected endpoint or stored Windows setting could not be verified.' 'Compare windows-native\config.json and CODEX_APP_SERVER_WS_URL in Windows Environment Variables.'
        return $false
    }
    if ($Endpoint.status -eq 'unset') {
        if ($DesktopConfigured) {
            Add-Check 'desktop' 'Store endpoint' 'down' 'The shared Desktop configuration has no stored endpoint for a normal Store launch.' 'Review the Windows Native switch and CODEX_APP_SERVER_WS_URL.'
        } else {
            Add-Check 'desktop' 'Store endpoint' 'optional' 'A normal Store launch has no stored endpoint in this headless configuration.'
        }
        return $false
    }
    $uri = $null
    if ([uri]::TryCreate([string]$Endpoint.value, [UriKind]::Absolute, [ref]$uri) -and
        !$uri.UserInfo -and !$uri.Query -and !$uri.Fragment -and $uri.AbsoluteUri -ceq $NativeUri.AbsoluteUri) {
        Add-Check 'desktop' 'Store endpoint' 'healthy' 'The stored Windows endpoint matches the configured Native backend.'
        return $true
    }
    $scope = if ($Endpoint.scope -eq 'user') { 'user' } else { 'machine' }
    Add-Check 'desktop' 'Store endpoint' 'down' "The stored $scope endpoint differs from the configured Native backend." 'Review CODEX_APP_SERVER_WS_URL in Windows Environment Variables before reopening Desktop.'
    $false
}

function Check-DesktopEvidence($Report, [bool]$SharedExpected, [bool]$LiveInspector) {
    $desktop = $Report.desktopTools
    $identity = $desktop.desktop
    Add-LiveProcess 'desktop' $identity
    Add-Inventory 'live Desktop executable' $identity.executable
    $evidence = $desktop.status
    if ($evidence -notin @('closed', 'connected', 'disconnected', 'unobservable')) {
        $evidence = if ($desktop.desktopBackendConnected) { 'connected' }
            elseif ($desktop.desktopPid) { 'disconnected' }
            elseif ($Report.PSObject.Properties['processes'] -and !@($Report.processes | Where-Object { [IO.Path]::GetFileName($_.executable) -eq 'ChatGPT.exe' }).Count) { 'closed' }
            else { 'unobservable' }
    }
    $sharedStatus = if ($SharedExpected) { 'down' } else { 'optional' }
    switch ($evidence) {
        'connected' { Add-Check 'desktop' 'backend attachment' 'healthy' 'Desktop has a verified connection to the shared loopback backend.' }
        'disconnected' { Add-Check 'desktop' 'backend attachment' $sharedStatus 'The verified Desktop process has no connection to the shared backend.' 'Review Desktop launch routing and reopen Desktop to pick up corrected settings.' }
        'closed' { Add-Check 'desktop' 'backend attachment' 'optional' 'Desktop is closed.' }
        default {
            $status = if ($SharedExpected) { 'unavailable' } else { 'optional' }
            Add-Check 'desktop' 'backend attachment' $status 'The inspector could not establish whether Desktop is running and attached.' 'Run the doctor from the deployment owner account and interactive session.'
        }
    }
    if ($desktop.ownerCheckedPipeFound -and $LiveInspector) {
        Add-Check 'desktop' 'tools pipe' 'healthy' 'The running Desktop owns a verified tools pipe.'
    } elseif ($evidence -eq 'closed') {
        Add-Check 'desktop' 'tools pipe' 'optional' 'A tools pipe becomes available when Desktop opens.'
    } elseif ($LiveInspector -and $evidence -in @('connected', 'disconnected')) {
        Add-Check 'desktop' 'tools pipe' $sharedStatus 'The running Desktop has no verified tools pipe.' 'Review the Desktop tools connection and the Native supervisor log.'
    } else {
        $status = if ($SharedExpected) { 'unavailable' } else { 'optional' }
        Add-Check 'desktop' 'tools pipe' $status 'The inspector could not verify ownership of a Desktop tools pipe.'
    }
    switch ($desktop.relay.status) {
        'verified' { Add-Check 'desktop' 'tools relay' 'healthy' 'The verified Native supervisor owns the tools relay.' }
        'other-process' { Add-Check 'desktop' 'tools relay' $sharedStatus 'A different process owns the tools relay.' 'Review the Native supervisor log and process identities.' }
        'unreachable' { Add-Check 'desktop' 'tools relay' $sharedStatus 'The tools relay did not accept a connection.' 'Review the Native supervisor log.' }
        'unobservable' {
            $status = if ($SharedExpected) { 'unavailable' } else { 'optional' }
            Add-Check 'desktop' 'tools relay' $status 'The inspector could not verify the tools relay owner.'
        }
    }
}

function Check-Native($Folder) {
    $nativeRoot = Join-Path $runtime 'windows-native'
    $configPath = Join-Path $nativeRoot 'config.json'
    $configFile = Read-PrivateJson $configPath
    $config = $configFile.data
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $nativeTask = if ($config.taskName -and $config.taskName -notmatch '[\\\x00-\x1F]') { $config.taskName } else { "HAPI Codex Native $sid" }
    $desktopTask = if ($config.desktopTaskName -and $config.desktopTaskName -notmatch '[\\\x00-\x1F]') { $config.desktopTaskName } else { "HAPI Codex Desktop $sid" }
    if (Test-Selected 'native') {
        Check-Task 'native' $nativeTask 'windows-native\run.ps1' (Find-Task $Folder $nativeTask) ([bool]$config) $true
    }
    $inspectDesktop = Test-Selected 'desktop'
    $desktopConfigured = [bool]($config.desktopTaskName -or $config.launchDesktop -eq $true)
    if ($inspectDesktop) {
        Check-Task 'desktop' $desktopTask 'windows-native\desktop.ps1' (Find-Task $Folder $desktopTask) ([bool]$config.desktopTaskName) $false
    }
    if ($configFile.status -eq 'absent') { return }
    $inspectPath = Join-Path $nativeRoot 'inspect.ps1'
    Add-Inventory 'native config' $configPath
    $parameters = @(Get-InspectorParameters $inspectPath)
    if ('BackendOnly' -notin $parameters -and $env:HAPI_DOCTOR_EXECUTABLE) {
        $portable = Find-PortableInspector
        if ($portable) {
            $inspectPath = $portable
            $parameters = @(Get-InspectorParameters $inspectPath)
        }
    }
    Add-Inventory 'native inspector' $inspectPath
    Add-Inventory 'native state' (Join-Path $nativeRoot 'state\managed.json')
    Add-Inventory 'native daemon log' (Join-Path $nativeRoot 'state\daemon-stderr.log')
    Add-Inventory 'native update receipt' (Join-Path $nativeRoot 'state\update-result.json')
    Add-Inventory 'native Node executable' $config.nodeExe
    Add-Inventory 'native Codex home' $config.codexHome
    Add-Inventory 'configured Desktop executable' $config.desktopExe
    $components = @('native', 'desktop') | Where-Object { Test-Selected $_ }
    if ($configFile.status -ne 'ok') {
        foreach ($component in $components) {
            Add-Check $component 'live inspection' 'unavailable' 'The native configuration or inspector is unavailable.' 'Review windows-native\config.json and inspect.ps1 in the installed runtime.'
        }
        return
    }
    $nativeUri = $null
    $validUri = [uri]::TryCreate([string]$config.websocketUrl, [UriKind]::Absolute, [ref]$nativeUri) -and
        $nativeUri.Scheme -eq 'ws' -and $nativeUri.Host -eq '127.0.0.1' -and $nativeUri.Port -ge 1024 -and
        $nativeUri.AbsolutePath -eq '/' -and !$nativeUri.UserInfo -and !$nativeUri.Query -and !$nativeUri.Fragment
    if ($validUri) { Add-Inventory 'native backend authority' "ws://127.0.0.1:$($nativeUri.Port)" }
    $storeSharesBackend = $false
    if ($inspectDesktop) {
        $expectedUri = if ($validUri) { $nativeUri }
        $storeSharesBackend = Check-StoreRouting $expectedUri $desktopConfigured (
            Read-StoreSetting 'CODEX_APP_SERVER_FORCE_CLI') (Read-StoreSetting 'CODEX_APP_SERVER_WS_URL')
    }
    if (!(Test-Path -LiteralPath $inspectPath -PathType Leaf)) {
        foreach ($component in $components) {
            Add-Check $component 'live inspection' 'unavailable' 'The Native inspector is unavailable.' 'Review windows-native\inspect.ps1 in the installed runtime.'
        }
        return
    }
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $inspectPath, '-CheckRunning')
    if ($parameters -contains 'DeploymentRoot') {
        $arguments += @('-DeploymentRoot', $nativeRoot)
    } elseif ($config.nodeExe -and $validUri) {
        $arguments += @('-NodeExe', $config.nodeExe, '-Port', [string]$nativeUri.Port)
        if ($config.codexHome) { $arguments += @('-CodexHome', $config.codexHome) }
    } else {
        foreach ($component in $components) {
            Add-Check $component 'live inspection' 'unavailable' 'The older native inspector requires a configured Node executable and loopback WebSocket endpoint.'
        }
        return
    }
    if ($parameters -contains 'LiveOnly') {
        $arguments += '-LiveOnly'
    }
    if (!$inspectDesktop -and $parameters -contains 'BackendOnly') {
        $arguments += '-BackendOnly'
    }
    $run = Run-Tool $powershell $arguments 55000
    $report = Get-JsonOutput $run
    if (!$report -or !$report.PSObject.Properties['ok']) {
        foreach ($component in $components) {
            $detail = if ($run.status -eq 'timeout') { 'The native inspector timed out.' } else { 'The native inspector did not return a usable report.' }
            Add-Check $component 'live inspection' 'unavailable' $detail 'Run the installed native inspector from the deployment owner account.'
        }
        return
    }
    Add-Inventory 'live Codex CLI executable' $report.paths.cli
    Add-Inventory 'detected Desktop executable' $report.paths.desktop
    foreach ($field in @('daemon','supervisor')) {
        $record = $report.native.$field
        if ($record -is [pscustomobject] -and $record.executable) { Add-Inventory "native $field executable" $record.executable }
        if ($report.native.ok) { Add-LiveProcess $field $record }
    }
    if (Test-Selected 'native') {
        $backendReady = if ($report.PSObject.Properties['ownedDaemonEndpointMatches']) {
            $report.native.ok -and $report.ownedDaemonEndpointMatches
        } else { $report.native.ok -and $report.ok }
        if ($backendReady) {
            Add-Check 'native' 'shared backend' 'healthy' 'The native inspector verified the loopback daemon.'
        } else {
            $code = if ($report.native.code -cmatch '^[A-Z][A-Z0-9_]{0,60}$') { " ($($report.native.code))" }
            Add-Check 'native' 'shared backend' 'down' "The native inspector could not verify the loopback daemon and its ownership$code." 'Review the native task and the native inspector with the configured runtime.'
        }
        if ($report.snapshot.status -in @('stale', 'missing', 'unreadable', 'current')) {
            $status = if ($report.snapshot.status -eq 'current') { 'healthy' } else { 'optional' }
            Add-Check 'native' 'managed snapshot' $status "The on-disk managed snapshot is $($report.snapshot.status)."
        }
    }
    if ($inspectDesktop) {
        Check-DesktopEvidence $report ($desktopConfigured -or $storeSharesBackend) ('LiveOnly' -in $parameters)
    }
}

function Read-SystemdUnits([string]$Output) {
    $units = @{}
    foreach ($block in ($Output -split '(?:\r?\n){2,}')) {
        $fields = @{}
        foreach ($line in ($block -split '\r?\n')) {
            if ($line -match '^(Id|Names|LoadState|ActiveState|SubState|UnitFileState)=(.*)$') {
                $fields[$Matches[1]] = $Matches[2]
            }
        }
        foreach ($name in @($fields.Id) + @($fields.Names -split ' ')) {
            if ($name) { $units[$name] = $fields }
        }
    }
    $units
}

function Check-Wsl($Services, $Folder) {
    $settings = $Services.data.wsl
    $taskName = 'Seia-WSL-Services'
    $found = Find-Task $Folder $taskName
    Check-Task 'wsl' $taskName 'start-wsl-services.ps1' $found ([bool]$settings) $true
    if (!$settings -and $found.status -ne 'ok') { return }
    Add-Inventory 'WSL distro' $settings.distribution
    Add-Inventory 'WSL service user' $settings.linuxUser
    Add-Inventory 'WSL keeper log' (Join-Path $runtime 'wsl-services.log')
    foreach ($value in @($settings.distribution, $settings.linuxUser)) {
        if ($value -isnot [string] -or $value -notmatch '^(?!-)[^"\\\x00-\x1F]+\z' -or $value.Trim() -ne $value) {
            Add-Check 'wsl' 'distribution' 'unavailable' 'No valid WSL distribution and owner were configured.' 'Review wsl in services.json.'
            return
        }
    }
    $running = Run-Tool $wslExe @('--list','--running','--quiet') 6000
    if ($running.status -ne 'ok' -or $running.code -ne 0) {
        Add-Check 'wsl' 'distribution' 'unavailable' 'WSL did not provide the list of running distributions.' 'From the deployment owner account, run wsl --list --running.'
        return
    }
    $names = @($running.output -split '\r?\n' | ForEach-Object { $_.Trim() })
    if ($settings.distribution -notin $names) {
        $registered = Run-Tool $wslExe @('--list','--quiet') 6000
        if ($registered.status -ne 'ok' -or $registered.code -ne 0) {
            Add-Check 'wsl' 'distribution' 'unavailable' 'WSL did not provide its registration list.' 'From the deployment owner account, run wsl --list.'
        } elseif ($settings.distribution -in @($registered.output -split '\r?\n' | ForEach-Object { $_.Trim() })) {
            Add-Check 'wsl' 'distribution' 'down' 'The configured distribution is stopped. Unit inspection was skipped.' 'Review the keeper task and wsl-services.log.'
        } else {
            Add-Check 'wsl' 'distribution' 'down' 'The configured distribution is not registered for this Windows account.' 'Compare wsl --list with services.json.'
        }
        return
    }
    Add-Check 'wsl' 'distribution' 'healthy' 'The configured distribution is running.'
    if ($settings.PSObject.Properties['units'] -and $settings.units -isnot [array]) {
        Add-Check 'wsl' 'configured units' 'unavailable' 'The configured unit list is invalid.' 'Check wsl.units in services.json.'
        return
    }
    $configured = @(foreach ($unit in $settings.units) {
        if ($unit -isnot [string] -or $unit -notmatch '^[A-Za-z0-9_.:@\\-]+$') {
            Add-Check 'wsl' 'configured units' 'unavailable' 'A configured unit name could not be inspected.' 'Check the systemd unit names in services.json.'
            continue
        }
        if ($unit -notmatch '\.(automount|device|mount|path|scope|service|slice|socket|swap|target|timer)$') { "$unit.service" }
        else { $unit }
    })
    $related = @('seia-codex-daemon.service', 'dsh-web.service', 'seia-auth.service',
        'termix.service', 'termix-backup.timer', 'termix-backup.service')
    $names = @($configured + $related | Select-Object -Unique)
    $args = @('--distribution', $settings.distribution, '--user', $settings.linuxUser,
        '--cd', '/', '--exec', '/usr/bin/timeout', '7s', '/usr/bin/systemctl', '--user',
        '--no-pager', 'show', '--property=Id,Names,LoadState,ActiveState,SubState,UnitFileState',
        '--') + $names
    $result = Run-Tool $wslExe $args 10000
    $units = Read-SystemdUnits $result.output
    if ($result.status -ne 'ok' -or $result.code -notin @(0,1) -or !$units.Count) {
        Add-Check 'wsl' 'systemd user units' 'unavailable' 'The configured user manager did not report unit states.' 'In the running distribution, check systemctl --user and loginctl linger.'
        return
    }
    foreach ($name in $names) {
        $unit = $units[$name]
        if (!$unit -or $unit.LoadState -eq 'not-found') {
            if ($name -in $configured) {
                Add-Check 'wsl' $name 'down' 'A configured user unit is missing.' 'Review systemctl --user list-unit-files in the running distribution.'
            }
            continue
        }
        $active = if ($unit.ActiveState -in @('active','inactive','failed','activating','deactivating','reloading','maintenance','refreshing')) { $unit.ActiveState } else { 'unknown' }
        $fileState = if ($unit.UnitFileState -in @('enabled','enabled-runtime','disabled','static','indirect','masked','masked-runtime','alias','generated','transient')) { $unit.UnitFileState } else { 'unknown' }
        if ($unit.LoadState -eq 'loaded' -and $active -eq 'active') {
            Add-Check 'wsl' $name 'healthy' "The user unit is active ($fileState)."
        } elseif ($name -in $configured -or $active -eq 'failed' -or $fileState -in @('enabled', 'enabled-runtime')) {
            Add-Check 'wsl' $name 'down' "The user unit is $active ($fileState)." "In the distribution, review systemctl --user status $name and its journal."
        } else { Add-Check 'wsl' $name 'optional' "The optional user unit is $active ($fileState)." }
    }
}

function Check-Hub($Services) {
    $runner = $Services.data.windowsRunner
    if (!$runner) {
        Add-Check 'hub' 'HTTP health' 'optional' 'No Hub HTTP endpoint is configured for the Windows runner.'
        return
    }
    $apiUrl = if ($runner.PSObject.Properties['apiUrl']) { $runner.apiUrl } else { 'http://127.0.0.1:3006' }
    $uri = Get-WebUri $apiUrl
    if (!$uri) {
        Add-Check 'hub' 'HTTP health' 'unavailable' 'The configured Hub URL is invalid.' 'Review windowsRunner.apiUrl in services.json.'
        return
    }
    Add-Inventory 'Hub authority' (Get-Authority $uri)
    $builder = [UriBuilder]::new($uri)
    $builder.Path = $builder.Path.TrimEnd('/') + '/health'
    Check-Web 'hub' 'HTTP health' $builder.Uri 'hub' 'Review the configured Hub endpoint and hapi-hub.service.'
}

function Check-ServeRules($Serve, [string]$Node, [ref]$RuleNumber) {
    foreach ($web in ($Serve.Web.PSObject.Properties | Sort-Object Name)) {
        foreach ($handler in ($web.Value.Handlers.PSObject.Properties | Sort-Object Name)) {
            $RuleNumber.Value++
            $label = "Serve rule $($RuleNumber.Value)"
            $port = 0
            $scheme = 'https'
            $front = $null
            if ($web.Name -match ':(?<port>\d+)$' -and [int]::TryParse($Matches.port, [ref]$port) -and $port -ge 1 -and $port -le 65535) {
                if ($Serve.TCP.$port.HTTP) { $scheme = 'http' }
                $front = Get-WebUri "${scheme}://$($web.Name)/"
            }
            if ($front -and $handler.Name.StartsWith('/')) {
                Add-Inventory "$label front authority" (Get-Authority $front)
                $frontBuilder = [UriBuilder]::new($front)
                $frontBuilder.Path = $handler.Name
                Check-Web 'tailscale' "$label front" $frontBuilder.Uri 'web' 'Compare the Serve listener with tailscale serve status and check tailnet reachability.'
            } else {
                Add-Check 'tailscale' "$label front" 'unavailable' 'The HTTP listener could not be interpreted.' 'Review tailscale serve status.'
            }
            if ($handler.Value.Proxy) {
                $upstream = Get-WebUri $handler.Value.Proxy
                if ($upstream) {
                    Add-Inventory "$label target authority" (Get-Authority $upstream)
                    Check-Web 'tailscale' "$label upstream" $upstream 'web' 'Check the origin service shown by tailscale serve status.'
                } elseif ($handler.Value.Proxy -like 'https+insecure://*') {
                    Add-Check 'tailscale' "$label upstream" 'optional' 'The direct target uses Serve-specific TLS handling.'
                } else {
                    Add-Check 'tailscale' "$label upstream" 'unavailable' 'The configured proxy target is not a supported HTTP endpoint.'
                }
            } elseif ($handler.Value.Path -or $handler.Value.Text) {
                Add-Check 'tailscale' "$label upstream" 'optional' 'This handler serves local content.'
            } else {
                Add-Check 'tailscale' "$label upstream" 'optional' 'No HTTP proxy target was reported for this handler.'
            }
        }
    }
    foreach ($tcp in ($Serve.TCP.PSObject.Properties | Sort-Object Name)) {
        if (!$tcp.Value.TCPForward) { continue }
        $RuleNumber.Value++
        $label = "Serve rule $($RuleNumber.Value)"
        $port = 0
        $front = if ($Node -and [int]::TryParse($tcp.Name, [ref]$port) -and $port -ge 1 -and $port -le 65535) {
            Get-WebUri "http://${Node}:${port}/"
        }
        $target = Get-WebUri "http://$($tcp.Value.TCPForward)/"
        if ($front) {
            Add-Inventory "$label front authority" ("tcp://{0}:{1}" -f $front.Host, $front.Port)
            if (Probe-Tcp $front) { Add-Check 'tailscale' "$label front" 'healthy' 'The forwarded TCP port accepted a connection.' }
            else { Add-Check 'tailscale' "$label front" 'down' 'The forwarded TCP port was unreachable.' 'Compare the Serve listener with tailscale serve status.' }
        } else {
            Add-Check 'tailscale' "$label front" 'unavailable' 'The TCP listener could not be interpreted.' 'Review tailscale serve status.'
        }
        if ($target) {
            Add-Inventory "$label target authority" ("tcp://{0}:{1}" -f $target.Host, $target.Port)
            if (Probe-Tcp $target) { Add-Check 'tailscale' "$label upstream" 'healthy' 'The TCP target accepted a connection.' }
            else { Add-Check 'tailscale' "$label upstream" 'down' 'The TCP target was unreachable.' 'Check the target service shown by tailscale serve status.' }
        } else {
            Add-Check 'tailscale' "$label upstream" 'unavailable' 'The TCP target could not be interpreted.'
        }
    }
}

function Check-Tailscale {
    $service = $null
    $serviceUnreadable = $false
    try { $service = Get-Service -Name Tailscale -ErrorAction Stop }
    catch { $serviceUnreadable = $_.FullyQualifiedErrorId -notlike 'NoServiceFoundForGivenName,*' }
    $tailscale = if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
    if (!$tailscale -or !(Test-Path -LiteralPath $tailscale -PathType Leaf)) {
        $command = Get-Command 'tailscale.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $tailscale = $command.Source
    }
    if (!$service -and !$tailscale -and !$serviceUnreadable) {
        Add-Check 'tailscale' 'Windows service' 'optional' 'Tailscale is not installed.'
        return
    }
    if ($serviceUnreadable) {
        Add-Check 'tailscale' 'Windows service' 'unavailable' 'Windows did not provide the Tailscale service state.'
    } elseif (!$service -or $service.Status -ne 'Running') {
        Add-Check 'tailscale' 'Windows service' 'down' 'The Tailscale Windows service is missing or stopped.' 'Review Tailscale in Windows Services.'
        return
    } else { Add-Check 'tailscale' 'Windows service' 'healthy' 'The Tailscale Windows service is running.' }
    if (!$tailscale) {
        Add-Check 'tailscale' 'client' 'unavailable' 'The Tailscale executable could not be located.'
        return
    }
    Add-Inventory 'Tailscale executable' $tailscale
    $run = Run-Tool $tailscale @('status','--json') 6000
    $status = Get-JsonOutput $run
    if (!$status.BackendState) {
        Add-Check 'tailscale' 'node' 'unavailable' 'The Tailscale client did not provide backend status.' 'Run tailscale status as the deployment owner.'
        return
    }
    if ($status.BackendState -ne 'Running' -or !$status.Self.Online -or !$status.TailscaleIPs) {
        Add-Check 'tailscale' 'node' 'down' 'The Tailscale node is offline or lacks an active connection.' 'Review the active Tailscale profile and tailscale status.'
        return
    }
    Add-Check 'tailscale' 'node' 'healthy' 'The Tailscale node is online.'
    $node = ([string]$status.Self.DNSName).TrimEnd('.')
    if (!$node -and $status.TailscaleIPs.Count) { $node = [string]$status.TailscaleIPs[0] }
    if ($node -match '^[A-Za-z0-9.:-]+$') { Add-Inventory 'Tailscale node' $node }
    if ($node.Contains(':')) { $node = "[$node]" }
    $run = Run-Tool $tailscale @('serve','status','--json') 6000
    $serve = Get-JsonOutput $run
    if ($run.status -ne 'ok' -or $run.code -ne 0 -or !$serve) {
        Add-Check 'tailscale' 'Serve configuration' 'unavailable' 'Tailscale did not report the Serve configuration.' 'Run tailscale serve status as the deployment owner.'
        return
    }
    $number = 0
    Check-ServeRules $serve $node ([ref]$number)
    foreach ($foreground in $serve.Foreground.PSObject.Properties) {
        Check-ServeRules $foreground.Value $node ([ref]$number)
    }
    if (!$number) { Add-Check 'tailscale' 'Serve configuration' 'optional' 'No HTTP or forwarded TCP Serve rules were reported.' }
}

try {
    $runtime = [IO.Path]::GetFullPath($runtime)
    $runtime = $runtime.TrimEnd('\', '/') + '\'
    if (!(Test-Path -LiteralPath $runtime -PathType Container)) {
        Add-Check 'doctor' 'runtime' 'unavailable' 'The selected Windows runtime directory could not be opened.' 'Pass --root with the installed runtime directory.'
    } else {
        Add-Inventory 'runtime root' $runtime
        Add-Inventory 'background install receipt' (Join-Path $runtime 'background-services\install-result.json')
        $servicesPath = Join-Path $runtime 'services.json'
        $services = Read-PrivateJson $servicesPath
        $nativeConfig = Join-Path $runtime 'windows-native\config.json'
        $inspectServices = (Test-Selected 'runner') -or (Test-Selected 'wsl') -or (Test-Selected 'hub')
        if ($inspectServices) {
            Add-Inventory 'service settings' $servicesPath
            if ($services.status -in @('invalid','unavailable')) {
                Add-Check 'doctor' 'services.json' 'unavailable' 'The service configuration could not be read as JSON.' 'Check services.json in the installed runtime.'
            } elseif ($services.status -eq 'absent' -and !(Test-Path -LiteralPath $nativeConfig -PathType Leaf)) {
                Add-Check 'doctor' 'runtime' 'unavailable' 'The directory has neither a service configuration nor a native configuration.' 'Pass --root with the installed runtime directory.'
            }
        }
        $folder = if ((Test-Selected 'runner') -or (Test-Selected 'native') -or (Test-Selected 'desktop') -or (Test-Selected 'wsl')) { Get-TaskFolder }
        $probes = [ordered]@{
            runner = { Check-Runner $services $folder }
            native = { Check-Native $folder }
            wsl = { Check-Wsl $services $folder }
            hub = { Check-Hub $services }
            tailscale = { Check-Tailscale }
        }
        foreach ($probe in $probes.GetEnumerator()) {
            $selected = (Test-Selected $probe.Key) -or ($probe.Key -eq 'native' -and (Test-Selected 'desktop'))
            if (!$selected) { continue }
            try { & $probe.Value }
            catch {
                $component = if ($probe.Key -eq 'native' -and !(Test-Selected 'native')) { 'desktop' } else { $probe.Key }
                Add-Check $component 'inspection' 'unavailable' 'The component did not provide all required diagnostic information.' 'Run this component individually from the deployment owner account.'
            }
        }
    }
} catch {
    Add-Check 'doctor' 'runtime' 'unavailable' 'The selected runtime could not be inspected.' 'Pass --root with the installed runtime directory.'
}
$exitCode = if ('unavailable' -in $checks.status) { 2 } elseif ('down' -in $checks.status) { 1 } else { 0 }
$status = @('healthy','degraded','unavailable')[$exitCode]
$report = [ordered]@{
    schemaVersion = 1
    checkedAtUtc = [DateTime]::UtcNow.ToString('o')
    status = $status
    exitCode = $exitCode
    checks = @($checks.ToArray())
}
if ($info) { $report.localInventory = $inventory }
if ($showProcesses) { $report.processes = $liveProcesses }
[Console]::WriteLine(($report | ConvertTo-Json -Depth 8 -Compress))
