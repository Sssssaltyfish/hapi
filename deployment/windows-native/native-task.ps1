function Get-CodexNativePayload {
    @('runtime.mjs', 'supervisor.mjs', 'desktop.ps1', 'desktop.mjs', 'process-info.ps1', 'find-tools-pipe.ps1',
        'resolve-runtime.ps1', 'run.ps1', 'install.ps1', 'configure-task.ps1', 'update.ps1', 'inspect.ps1',
        'inspect.mjs', 'live-backend.ps1', 'native-task.ps1', 'schedule-switch.ps1', 'switch.ps1', 'rollback.ps1')
}

function Resolve-CodexTaskSid([string]$Account) {
    if ($Account -like 'S-1-*') { return $Account }
    if ($Account) { return [Security.Principal.NTAccount]::new($Account).Translate([Security.Principal.SecurityIdentifier]).Value }
}

function Get-CodexTaskAction([string]$Root, [string]$Entry) {
    $bootstrap = Join-Path (Split-Path -Parent $Root) 'task-bootstrap.js'
    $script = Join-Path $Root $Entry
    @{
        Execute = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
        Argument = "//B //NoLogo `"$bootstrap`" `"$script`" `"$Root`""
        WorkingDirectory = $Root
    }
}

function Test-CodexTaskAction([string]$Root, [string]$Entry, [string]$Execute, [string]$Arguments, [string]$Directory, [switch]$AllowLegacy) {
    $expected = Get-CodexTaskAction $Root $Entry
    if ($Directory.TrimEnd('\') -ne $Root.TrimEnd('\')) { return $false }
    if ($Execute -eq $expected.Execute -and $Arguments.Trim() -eq $expected.Argument) { return $true }
    if (!$AllowLegacy -or $Entry -ne 'run.ps1') { return $false }

    $script = Join-Path $Root $Entry
    $parentRoot = Split-Path -Parent $Root
    $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $launcher = Join-Path $parentRoot 'task-launcher.ps1'
    if ($Execute -eq $powershell) {
        return $Arguments.Trim() -in @(
            "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"",
            "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Script `"$script`" -WorkingDirectory `"$Root`"")
    }
    return $Execute -in @((Join-Path $parentRoot 'hidden-task-launcher\HiddenTaskLauncher.exe'),
        (Join-Path $parentRoot 'hidden-task-launcher\HiddenTaskLauncher-v2.exe')) -and
        $Arguments.Trim() -eq "`"$script`" `"$Root`" Bypass"
}

function Get-CodexDeploymentTask {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$OwnerSid,
        [Parameter(Mandatory)][ValidateSet('run.ps1','desktop.ps1','switch.ps1')][string]$Entry,
        [switch]$AllowLegacy,
        [switch]$Optional
    )
    if ($Name -match '[\\/*?\[\]]') { throw 'Invalid managed task name.' }
    $task = Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue
    if (!$task) {
        if ($Optional) { return }
        throw "Managed task is missing: $Name."
    }
    $logonTypes = if ($AllowLegacy -and $Entry -eq 'run.ps1') { @('Interactive','S4U') } else { @('Interactive') }
    if ($task.TaskName -ne $Name -or $task.TaskPath -ne '\' -or
        (Resolve-CodexTaskSid $task.Principal.UserId) -ne $OwnerSid -or
        $task.Principal.RunLevel -ne 'Limited' -or $task.Principal.LogonType -notin $logonTypes -or
        $task.Actions.Count -ne 1 -or !(Test-CodexTaskAction $Root $Entry $task.Actions[0].Execute `
            $task.Actions[0].Arguments $task.Actions[0].WorkingDirectory -AllowLegacy:$AllowLegacy)) {
        throw "Task $Name does not belong to this deployment."
    }
    $task
}

function Get-CodexTaskFolder {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $service.GetFolder('\')
}

function Assert-CodexCandidateTask([string]$Root, [string]$OwnerSid, [string]$Xml) {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $definition = $service.NewTask(0)
    $definition.XmlText = $Xml
    if ((Resolve-CodexTaskSid $definition.Principal.UserId) -ne $OwnerSid -or
        $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or
        !$definition.Settings.Enabled -or $definition.Settings.MultipleInstances -ne 2 -or
        $definition.Triggers.Count -ne 1 -or $definition.Triggers.Item(1).Type -ne 9 -or
        (Resolve-CodexTaskSid $definition.Triggers.Item(1).UserId) -ne $OwnerSid -or
        $definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Type -ne 0) {
        throw 'The candidate task requires a single logon trigger and action for the deployment owner.'
    }
    $action = $definition.Actions.Item(1)
    if (!(Test-CodexTaskAction $Root 'run.ps1' $action.Path $action.Arguments $action.WorkingDirectory)) {
        throw 'The candidate task does not target this deployment.'
    }
}

function Test-CodexProcessGeneration($Identity) {
    if (!$Identity.pid -or !$Identity.started) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Identity.pid)"
    # Windows may retain the process row after removing some metadata.
    return $process -and (!$process.CreationDate -or
        $process.CreationDate.ToUniversalTime() -eq ([DateTimeOffset]$Identity.started).UtcDateTime)
}
