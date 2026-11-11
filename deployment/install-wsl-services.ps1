[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'HAPI'),
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install-background-services.ps1') -RuntimeRoot $RuntimeRoot -WslOnly -ValidateOnly:$ValidateOnly
