[CmdletBinding()]
param([string]$WorkspaceRoot = (Join-Path $env:USERPROFILE 'codex-temp'))

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$deployment = Split-Path $root -Parent
$launcher = Join-Path $deployment 'task-launcher.ps1'
$oldLauncher = Join-Path $root 'HiddenTaskLauncher.exe'
$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).ProviderPath
$specs = @(
    @{name='HAPI-Windows-Runner'; script="$deployment\start-windows-runner.ps1"; directory=$WorkspaceRoot; suffix=''; backup='runner-before.xml'},
    @{name="HAPI Codex Native $ownerSid"; script="$deployment\windows-native\run.ps1"; directory="$deployment\windows-native"; suffix=' Bypass'; backup='native-before.xml'}
)

function Test-Action($Action, $Spec) {
    return $Action.Execute -eq $powershell -and $Action.Arguments -ceq $Spec.arguments -and
        $Action.WorkingDirectory -eq $Spec.directory
}

if (!(Test-Path -LiteralPath $launcher -PathType Leaf) -or
    !(Test-Path -LiteralPath (Join-Path $deployment 'task-lifetime.ps1') -PathType Leaf)) { throw 'The PowerShell task launcher is unavailable.' }
$operation = [IO.File]::Open((Join-Path $root 'apply.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    foreach ($spec in $specs) {
        if (!(Test-Path -LiteralPath $spec.script -PathType Leaf) -or !(Test-Path -LiteralPath $spec.directory -PathType Container)) {
            throw "The script or working directory for $($spec.name) is unavailable."
        }
        $task = Get-ScheduledTask -TaskName $spec.name -TaskPath '\'
        $principal = $task.Principal.UserId
        if ($principal -notlike 'S-1-*') {
            $principal = [Security.Principal.NTAccount]::new($principal).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($task.Actions.Count -ne 1 -or $principal -ne $ownerSid) { throw "Unexpected task definition for $($spec.name)." }

        $spec.arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Script "{1}" -WorkingDirectory "{2}"' -f
            $launcher, $spec.script, ($spec.directory -replace '(\\+)$', '$1$1')
        $spec.previousAction = $task.Actions[0]
        $action = $spec.previousAction
        $scriptPattern = [regex]::Escape($spec.script)
        $legacyArguments = '^\s*(?:(?:-NoProfile|-NonInteractive|-WindowStyle Hidden|-ExecutionPolicy Bypass)\s+)*-File\s+(?:"' +
            $scriptPattern + '"|' + $scriptPattern + ')\s*$'
        $oldArguments = '"{0}" "{1}"{2}' -f $spec.script, $spec.directory, $spec.suffix
        $existingLauncher = $action.Execute -eq $oldLauncher -and $action.Arguments -ieq $oldArguments -and
            $action.WorkingDirectory -eq $spec.directory
        $legacyPowerShell = $action.Execute -in @($powershell, 'powershell.exe') -and $action.Arguments -match $legacyArguments
        if (!(Test-Action $action $spec) -and !$existingLauncher -and !$legacyPowerShell) { throw "Unexpected task action for $($spec.name)." }

        $actionParams = @{ Execute = $powershell; Argument = $spec.arguments; WorkingDirectory = $spec.directory }
        if ($action.Id) { $actionParams.Id = $action.Id }
        $spec.nextAction = New-ScheduledTaskAction @actionParams
    }

    foreach ($spec in $specs) {
        $backup = Join-Path $root $spec.backup
        if (!(Test-Path -LiteralPath $backup -PathType Leaf)) {
            $temporary = "$backup.$PID.tmp"
            try {
                $xml = Export-ScheduledTask -TaskName $spec.name -TaskPath '\'
                [IO.File]::WriteAllText($temporary, $xml, [Text.Encoding]::Unicode)
                [IO.File]::Move($temporary, $backup)
            } finally { [IO.File]::Delete($temporary) }
        }
    }

    $changed = [Collections.Generic.List[object]]::new()
    try {
        foreach ($spec in $specs) {
            if (Test-Action $spec.previousAction $spec) { continue }
            $changed.Add($spec)
            Set-ScheduledTask -TaskName $spec.name -TaskPath '\' -Action $spec.nextAction | Out-Null
            $updated = Get-ScheduledTask -TaskName $spec.name -TaskPath '\'
            if ($updated.Actions.Count -ne 1 -or !(Test-Action $updated.Actions[0] $spec)) {
                throw "Task action verification failed for $($spec.name)."
            }
        }
    } catch {
        $updateFailure = $_
        $restoreFailures = @()
        for ($index = $changed.Count - 1; $index -ge 0; $index--) {
            $spec = $changed[$index]
            try { Set-ScheduledTask -TaskName $spec.name -TaskPath '\' -Action $spec.previousAction | Out-Null }
            catch { $restoreFailures += $spec.name }
        }
        if ($restoreFailures) { throw "Task update failed and restoration failed for $($restoreFailures -join ', '). $updateFailure" }
        throw $updateFailure
    }

    Get-ScheduledTask -TaskName $specs.name -TaskPath '\' | ForEach-Object {
        [pscustomobject]@{Name=$_.TaskName;State=[string]$_.State;Actions=@($_.Actions | Select-Object Execute,Arguments,WorkingDirectory)}
    } | ConvertTo-Json -Depth 4
} finally { $operation.Dispose() }
