function Get-TaskLauncher {
    $pidText = $env:HAPI_TASK_LAUNCHER_PID
    $startText = $env:HAPI_TASK_LAUNCHER_START_TICKS
    $env:HAPI_TASK_LAUNCHER_PID = $null
    $env:HAPI_TASK_LAUNCHER_START_TICKS = $null
    $launcher = [pscustomobject]@{ Scheduled = ($null -ne $pidText -or $null -ne $startText); Process = $null }
    $launcherId = 0
    $started = 0L
    if ([int]::TryParse($pidText, [ref]$launcherId) -and $launcherId -gt 0 -and [long]::TryParse($startText, [ref]$started)) {
        $candidate = $null
        try {
            $candidate = [Diagnostics.Process]::GetProcessById($launcherId)
            # Hold the handle so later checks keep referring to this generation.
            $null = $candidate.Handle
            if (!$candidate.HasExited -and $candidate.StartTime.ToUniversalTime().Ticks -eq $started) {
                $launcher.Process = $candidate
            }
        } catch [ArgumentException] {
        } catch [InvalidOperationException] {
        } catch [ComponentModel.Win32Exception] {
        } finally {
            if ($candidate -and !$launcher.Process) { $candidate.Dispose() }
        }
    }
    return $launcher
}

function Test-TaskLauncherRunning($Launcher) {
    return !$Launcher.Scheduled -or ($Launcher.Process -and !$Launcher.Process.HasExited)
}

function Wait-TaskRetry($Launcher, [int]$Seconds) {
    if (!(Test-TaskLauncherRunning $Launcher)) { return $false }
    if ($Launcher.Process) { return !$Launcher.Process.WaitForExit($Seconds * 1000) }
    Start-Sleep -Seconds $Seconds
    return $true
}

function Enter-TaskInstance($Launcher, [string]$Path) {
    while (Test-TaskLauncherRunning $Launcher) {
        try { return [IO.File]::Open($Path, 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if (($_.Exception.HResult -band 0xffff) -notin @(32, 33)) { throw }
            if (!$Launcher.Scheduled -or !(Wait-TaskRetry $Launcher 1)) { return }
        }
    }
}

function Open-TaskLog([string]$Path) {
    $encoding = [Text.UTF8Encoding]::new($false)
    if ([IO.File]::Exists($Path)) {
        $reader = [IO.StreamReader]::new([IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite'), $encoding, $true)
        try {
            $null = $reader.Peek()
            $encoding = $reader.CurrentEncoding
        } finally { $reader.Dispose() }
    }
    $writer = [IO.StreamWriter]::new([IO.File]::Open($Path, 'Append', 'Write', 'ReadWrite'), $encoding)
    $writer.AutoFlush = $true
    return $writer
}

function Write-TaskLog($Log, [string]$Message) {
    if ($Log) {
        try { $Log.WriteLine($Message) } catch [IO.IOException] { }
    }
}

function Write-TaskStatus($Log, [string]$Message) {
    Write-TaskLog $Log "$([DateTime]::UtcNow.ToString('o')) $Message"
}

function Invoke-TaskChild {
    param($Launcher, $Log, [string]$Executable, [string]$Arguments, [string]$WorkingDirectory, [switch]$KeepInputOpen)
    if (!(Test-TaskLauncherRunning $Launcher)) { return }
    $start = [Diagnostics.ProcessStartInfo]::new($Executable, $Arguments)
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $KeepInputOpen.IsPresent
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    $started = $false
    try {
        $started = $child.Start()
        if (!$started) { throw "Could not start $Executable." }
        $streams = foreach ($reader in @($child.StandardOutput, $child.StandardError)) {
            [pscustomobject]@{ Reader = $reader; Pending = $reader.ReadLineAsync() }
        }
        $drain = $null
        while ($true) {
            if (!(Test-TaskLauncherRunning $Launcher)) {
                Write-TaskStatus $Log "Launcher exited. Stopping $([IO.Path]::GetFileName($Executable))."
                return
            }
            if (!$drain -and $child.HasExited) { $drain = [Diagnostics.Stopwatch]::StartNew() }
            $handled = $false
            foreach ($stream in $streams) {
                for ($count = 0; $count -lt 64 -and $stream.Pending -and $stream.Pending.IsCompleted; $count++) {
                    $line = $stream.Pending.GetAwaiter().GetResult()
                    if ($null -eq $line) {
                        $stream.Pending = $null
                    } else {
                        Write-TaskLog $Log $line
                        $stream.Pending = $stream.Reader.ReadLineAsync()
                    }
                    $handled = $true
                }
            }
            # A detached descendant can keep a redirected output handle open.
            if ($drain -and (($null -eq $streams[0].Pending -and $null -eq $streams[1].Pending) -or
                $drain.ElapsedMilliseconds -ge 1000)) { return $child.ExitCode }
            if (!$handled) { Start-Sleep -Milliseconds 100 }
        }
    } finally {
        try {
            if ($started -and !$child.HasExited) {
                if ($KeepInputOpen) {
                    # A foreground Linux reader receives EOF before the Windows client is stopped.
                    try { $child.StandardInput.Close() } catch [IO.IOException] { }
                    $null = $child.WaitForExit(1000)
                }
                if (!$child.HasExited) {
                    try { $child.Kill() }
                    catch [InvalidOperationException] { if (!$child.HasExited) { throw } }
                    catch [ComponentModel.Win32Exception] { if (!$child.HasExited) { throw } }
                }
                if (!$child.WaitForExit(5000)) { throw "Timed out stopping $Executable." }
            }
        } finally { $child.Dispose() }
    }
}
