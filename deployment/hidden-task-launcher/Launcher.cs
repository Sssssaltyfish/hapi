using System;
using System.Diagnostics;
using System.IO;

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2 || args.Length > 3) return 64;
            string script = Path.GetFullPath(args[0]);
            string directory = Path.GetFullPath(args[1]);
            if (!File.Exists(script) || !Directory.Exists(directory) || script.Contains("\"")) return 66;
            if (args.Length == 3 && args[2] != "Bypass") return 64;
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive" + (args.Length == 3 ? " -ExecutionPolicy Bypass" : "") + " -File \"" + script + "\"",
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception ex)
        {
            try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher-errors.log"), DateTime.UtcNow.ToString("o") + " " + ex + Environment.NewLine); } catch { }
            return 1;
        }
    }
}
