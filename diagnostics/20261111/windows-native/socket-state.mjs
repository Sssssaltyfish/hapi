import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const command = `Get-NetTCPConnection -OwningProcess ${process.pid} -LocalPort ${port} | Select-Object LocalAddress,LocalPort,State,@{n='rawState';e={$_.CimInstanceProperties['State'].Value}} | ConvertTo-Json -Compress`;
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', command], { windowsHide: true, encoding: 'utf8' });
    console.log(result.stdout.trim());
    server.close();
});
