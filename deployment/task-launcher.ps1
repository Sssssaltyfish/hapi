[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Script,
    [Parameter(Mandatory)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
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
$self = [Diagnostics.Process]::GetCurrentProcess()
try {
    $start.EnvironmentVariables['HAPI_TASK_LAUNCHER_PID'] = $self.Id.ToString([Globalization.CultureInfo]::InvariantCulture)
    $start.EnvironmentVariables['HAPI_TASK_LAUNCHER_START_TICKS'] = $self.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
} finally { $self.Dispose() }

$child = [Diagnostics.Process]::Start($start)
try {
    $child.WaitForExit()
    exit $child.ExitCode
} finally { $child.Dispose() }
