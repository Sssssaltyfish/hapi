[CmdletBinding()]
param([string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'HAPI'))
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run ARSO setup with administrator permission as the deployment owner.'
}
$computer = Get-CimInstance Win32_ComputerSystem
$join = & "$env:WINDIR\System32\dsregcmd.exe" /status
if ($LASTEXITCODE -or $computer.PartOfDomain -or ($join -match 'AzureAdJoined\s*:\s*YES')) {
    throw 'This setup requires an unmanaged PC: managed-device ARSO has different restart conditions.'
}
$volume = Get-BitLockerVolume -MountPoint $env:SystemDrive
$secure = [string]$volume.ProtectionStatus -eq 'On'
$sid = $identity.User.Value
$policy = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$userArso = "$winlogon\UserARSO\$sid"
$lockTaskName = "Seia Lock After Sign-In $sid"
$lockTask = Get-ScheduledTask -TaskName $lockTaskName -ErrorAction SilentlyContinue
if ($lockTask -and ($lockTask.Actions.Count -ne 1 -or $lockTask.Actions[0].Arguments -notlike "*`"$RuntimeRoot\lock-user-session.ps1`"*")) {
    throw 'Unexpected task with the former automatic-lock task name.'
}

# Delete only Autologon's DefaultPassword secret. Never retrieve or serialize it.
# LsaStorePrivateData(..., NULL) deletes both the private data and its key.
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SeiaAutologonCleanup {
    [StructLayout(LayoutKind.Sequential)] struct Attributes {
        public uint Length; public IntPtr Root, Name; public uint Flags; public IntPtr Security, Quality;
    }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString {
        public ushort Length, MaximumLength; public IntPtr Buffer;
    }
    [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attrs, uint access, out IntPtr handle);
    [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr handle, ref UnicodeString key, IntPtr value);
    [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
    [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
    public static void DeletePassword() {
        var attrs = new Attributes { Length=(uint)Marshal.SizeOf(typeof(Attributes)) };
        IntPtr handle;
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x20, out handle);
        if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        const string name = "DefaultPassword";
        var key = new UnicodeString { Length=(ushort)(name.Length*2), MaximumLength=(ushort)((name.Length+1)*2), Buffer=Marshal.StringToHGlobalUni(name) };
        try {
            status = LsaStorePrivateData(handle, ref key, IntPtr.Zero);
            if (status != 0 && status != 0xC0000034) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        } finally { Marshal.FreeHGlobal(key.Buffer); LsaClose(handle); }
    }
}
'@

New-ItemProperty -Path $policy -Name DisableAutomaticRestartSignOn -PropertyType DWord -Value 0 -Force | Out-Null
# Retain the disk's current encryption configuration. Unencrypted PCs need the
# documented Always Enabled mode; do not silently change disk encryption here.
$mode = if ($secure) { 0 } else { 1 }
New-ItemProperty -Path $policy -Name AutomaticRestartSignOnConfig -PropertyType DWord -Value $mode -Force | Out-Null
New-Item -Path $userArso -Force | Out-Null
New-ItemProperty -Path $userArso -Name OptOut -PropertyType DWord -Value 0 -Force | Out-Null
New-ItemProperty -Path $winlogon -Name AutoAdminLogon -PropertyType String -Value '0' -Force | Out-Null
[SeiaAutologonCleanup]::DeletePassword()
if ((Get-Item -LiteralPath $winlogon).GetValueNames() -contains 'DefaultPassword') {
    Remove-ItemProperty -LiteralPath $winlogon -Name DefaultPassword
}
if ($lockTask) { Unregister-ScheduledTask -TaskName $lockTaskName -Confirm:$false }
Remove-Item -LiteralPath "$RuntimeRoot\lock-user-session.ps1" -Force -ErrorAction SilentlyContinue
$setupName = "Seia Autologon Setup $sid"
$setup = Get-ScheduledTask -TaskName $setupName -ErrorAction SilentlyContinue
if ($setup) {
    if ($setup.State -eq 'Running' -or $setup.Actions.Count -ne 1 -or $setup.Actions[0].Execute -notlike '*\autologon\Autologon64.exe') {
        throw 'Review the unfinished Autologon setup task.'
    }
    Unregister-ScheduledTask -TaskName $setupName -Confirm:$false
}
@{ arsoEnabled=$true; bitLockerProtection=[string]$volume.ProtectionStatus; arsoMode=$mode; autoAdminLogon='0'; savedAutologonPasswordDeleted=$true; lockHandledBy='Winlogon'; ownerSid=$sid } | ConvertTo-Json -Compress
