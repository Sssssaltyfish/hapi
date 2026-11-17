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

`install.ps1` 自动发现 Desktop 和 CLI，也接受 `-CliExe` 固定后端程序。需要单独指定工具运行时时可用 `-McpNodeExe`、`-BrowserNodeExe`。Codex home 和端口也可显式选择。

默认暂存两个停用的有限权限 Interactive 登录任务。指定 `-NoDesktopTask` 时只安装后台任务，桌面可以手动打开。首次接线成功后才写用户级 `CODEX_APP_SERVER_WS_URL`。已有安装通过更新流程保留任务名。

## 正式切换

先结束目标 Desktop 的正在进行工作并退出原 Desktop。然后从独立 Windows PowerShell 执行：

```powershell
./switch.ps1
```

它先启动 backend，验证真实握手、监听进程和 supervisor。选装了 Desktop 任务时再打开桌面并验证连接。成功后提交用户级 endpoint。切换开始后遇到故障会回退。

需要从原 Desktop 发起切换时，可使用 `schedule-switch.ps1`，明确提供当前进程的 PID 和启动时间，使独立计划任务只处理该进程代际。该入口参数及示例以 Native README 为准；不要使用广泛杀进程的方式。

## 验证与恢复

用 `service-doctor.exe check` 检查整个部署，或用 `windows-native/inspect.ps1 -LiveOnly` 检查后台。来自实时握手与进程的结果在 `native`，工具连接在 `desktopTools`，上次快照的比对在 `snapshot`。再从 HAPI 读取同一会话。模型出站网络另行验证，见 [网络与环境](NETWORK_AND_ENVIRONMENT.md)。

`rollback.ps1` 停止并移除本套安装的任务并恢复此前 endpoint。Codex home 和真实会话保留。单独更新 backend 时从候选目录运行 `update.ps1`，已停止的实例可使用 `-Stopped`，详见 [Native 更新步骤](windows-native/README.md#update-an-existing-managed-backend)。整套更新器的预检、ARSO 与 WSL keeper 见 [Windows 服务](WINDOWS_SERVICES.md)。

不同 Desktop 版本的内部接线需要重新核对。分发包记录源版本和既有验证范围；目标机器应自行完成安装及计划中的重启验收。
