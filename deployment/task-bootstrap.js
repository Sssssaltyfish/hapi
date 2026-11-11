// Windows Script Host is a GUI executable: start PowerShell hidden before a
// console is allocated. Service ownership and recovery stay in PowerShell.
var shell = new ActiveXObject('WScript.Shell');
var fs = new ActiveXObject('Scripting.FileSystemObject');
function quote(value) {
    if (value.indexOf('"') !== -1) throw new Error('Quotes are not valid in a path.');
    return '"' + value.replace(/(\\+)$/, '$1$1') + '"';
}
if (WScript.Arguments.length !== 2) WScript.Quit(2);
var root = fs.GetParentFolderName(WScript.ScriptFullName);
var entry = fs.GetAbsolutePathName(WScript.Arguments(0));
var directory = fs.GetAbsolutePathName(WScript.Arguments(1));
if (!fs.FileExists(entry) || !fs.FolderExists(directory)) WScript.Quit(2);
shell.CurrentDirectory = directory;
shell.Environment('PROCESS')('HAPI_TASK_BOOTSTRAP') = WScript.ScriptFullName;
var powershell = shell.ExpandEnvironmentStrings('%SystemRoot%') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
var command = quote(powershell) + ' -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' +
    quote(root + '\\task-launcher.ps1') + ' -Script ' + quote(entry) + ' -WorkingDirectory ' + quote(directory);
WScript.Quit(shell.Run(command, 0, true));
