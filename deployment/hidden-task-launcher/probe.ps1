$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ConsoleProbe {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
@{ pid=$PID; consoleWindow=[ConsoleProbe]::GetConsoleWindow().ToInt64(); at=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath "$PSScriptRoot\probe-result.json"
exit 37
