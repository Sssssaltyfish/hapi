param(
    [string]$Distribution = 'Ubuntu-26.04',
    [string]$LinuxUser = 'igna'
)

$ErrorActionPreference = 'Stop'
$wsl = Join-Path ([Environment]::SystemDirectory) 'wsl.exe'
while ($true) {
    # A Windows-side client keeps the service distro alive independently of
    # Desktop. systemd still owns and supervises the actual Linux services.
    & $wsl --distribution $Distribution --user $LinuxUser --exec /bin/sleep infinity
    Start-Sleep -Seconds 5
}
