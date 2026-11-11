# Windows Desktop 首次接入共享 backend

本指南使用假想路径。已有安装升级请使用 `windows-native/update.ps1` 或 [整套服务更新器](WINDOWS_SERVICES.md)，不要重复首次安装覆盖私有配置。

## 准备

1. 在目标 Windows 用户下安装并登录 Codex Desktop，确认普通 Desktop 和默认工具可以工作。
2. 准备 Node.js 与持久 runtime 目录。不要把运行入口放在准备删除的下载目录或开发临时工作区。
3. 按 [windows-native/README.md](windows-native/README.md) 将参考脚本放进 runtime 的 `windows-native/`，共享 `task-bootstrap.js`、`task-launcher.ps1`、`task-lifetime.ps1` 放在它的父目录。保留这层相对结构。

例如 runtime 是 `D:\Services\HAPI`，Node 是 `D:\Tools\node\node.exe`。这些是示意值。

## 检查与 staging

在部署所有者的 PowerShell 中运行只读检查；真实参数以随包脚本的 `param` 和 Native README 为准：

```powershell
cd D:\Services\HAPI\windows-native
./inspect.ps1 -NodeExe 'D:\Tools\node\node.exe'
./install.ps1 -NodeExe 'D:\Tools\node\node.exe'
```

`install.ps1` 自动发现已安装的 Desktop 和 CLI；`-DesktopExe`、`-CliExe` 属于只读 inspect 的覆盖参数，不能直接传给 installer。需要专用工具运行时时可用 installer 的 `-McpNodeExe`、`-BrowserNodeExe`；Codex home 和端口也可显式选择。

staging 创建两项有限权限 Interactive 登录任务，但保持停用，backend 配置为 `launchDesktop: false`。此时不改用户级 `CODEX_APP_SERVER_WS_URL`。发现已有安装时先检查并使用更新流程。

## 正式切换

先结束目标 Desktop 的正在进行工作并退出原 Desktop。然后从独立 Windows PowerShell 执行：

```powershell
./switch.ps1
```

它先启动 backend 并验证身份，再启动 Desktop 并验证 backend/工具连接；成功后提交用户级 endpoint。失败会停止本次实例、停用 staged tasks 并恢复此前 endpoint。

需要从原 Desktop 发起切换时，可使用 `schedule-switch.ps1`，明确提供当前进程的 PID 和启动时间，使独立计划任务只处理该进程代际。该入口参数及示例以 Native README 为准；不要使用广泛杀进程的方式。

## 验证与恢复

检查 `state/managed.json` 的新鲜状态，以及 `inspect.ps1` 中的真实 initialize、`ownedDaemonEndpointMatches`、Desktop backend 和工具连接结果。再从 HAPI 读取同一会话。服务 ready 与模型出站网络可用是不同检查；代理建议见 [网络与环境](NETWORK_AND_ENVIRONMENT.md)。

`rollback.ps1` 停止并移除本套 Native/Desktop 任务，恢复此前 endpoint；不删除 Codex home 和真实会话。回退后可重新正常打开 Desktop。新版本更新先运行 `update.ps1 -ValidateOnly`，再从独立进程执行更新。持续启动恢复、ARSO 与 WSL keeper 见 [Windows 服务](WINDOWS_SERVICES.md)。

不同 Desktop 版本的内部接线需要重新核对。分发包记录源版本和既有验证范围；目标机器应自行完成安装及计划中的重启验收。
