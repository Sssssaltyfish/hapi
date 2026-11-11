[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Script,
    [Parameter(Mandatory)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
trap {
    [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'task-launcher-errors.log'), "$([DateTime]::UtcNow.ToString('o')) $Script : $($_.Exception.Message)`r`n")
    exit 1
}
$entry = (Resolve-Path -LiteralPath $Script).ProviderPath
$directory = (Resolve-Path -LiteralPath $WorkingDirectory).ProviderPath
if (!(Test-Path -LiteralPath $entry -PathType Leaf) -or $entry.Contains('"') -or
    !(Test-Path -LiteralPath $directory -PathType Container)) { throw 'Task script or working directory is unavailable.' }

$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $entry
$start = [Diagnostics.ProcessStartInfo]::new($powershell, $arguments)
$start.WorkingDirectory = $directory
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$bootstrap = $null
$self = [Diagnostics.Process]::GetCurrentProcess()
try {
    if ($env:HAPI_TASK_BOOTSTRAP) {
        $expected = (Join-Path $PSScriptRoot 'task-bootstrap.js')
        if ($env:HAPI_TASK_BOOTSTRAP -ne $expected) { throw 'Unexpected task bootstrap path.' }
        $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
        $bootstrap = [Diagnostics.Process]::GetProcessById($parentId)
        $null = $bootstrap.Handle
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId"
        if ($bootstrap.HasExited -or $parent.ExecutablePath -ne (Join-Path ([Environment]::SystemDirectory) 'wscript.exe') -or
            $parent.CommandLine -notmatch [regex]::Escape($expected) -or
            $bootstrap.StartTime.ToUniversalTime() -gt $self.StartTime.ToUniversalTime()) {
            throw 'Unexpected task bootstrap process.'
        }
    }
    $start.EnvironmentVariables.Remove('HAPI_TASK_BOOTSTRAP')
    $start.EnvironmentVariables['HAPI_TASK_LAUNCHER_PID'] = $self.Id.ToString([Globalization.CultureInfo]::InvariantCulture)
    $start.EnvironmentVariables['HAPI_TASK_LAUNCHER_START_TICKS'] = $self.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
} finally { $self.Dispose() }

$child = [Diagnostics.Process]::Start($start)
try {
    while (!$child.WaitForExit(500)) {
        # Ending the GUI host ends this launcher. The child observes our retained
        # process handle and performs its normal worker cleanup.
        if ($bootstrap -and $bootstrap.HasExited) { exit 0 }
    }
    exit $child.ExitCode
} finally {
    $child.Dispose()
    if ($bootstrap) { $bootstrap.Dispose() }
}
