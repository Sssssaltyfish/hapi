# Windows 服务启动与恢复

本文描述当前部署方式。目录、发行版、用户名和域名示例都是假想数据；按目标机器填写私有配置。Windows Native、Windows Runner、WSL 和共享认证可以按需选用，不要求全部安装。

## 启动关系

Windows Tailscale 使用官方系统服务。选择无人值守运行时，在该机器配置 `tailscale set --unattended=true`。应用的四个入口分别是部署所有者的有限权限登录任务：

| 入口 | 职责 |
| --- | --- |
| Windows Codex backend | 监督同一 Windows daemon，独立于 Desktop 窗口 |
| Codex Desktop | 等待 backend 就绪，再连接它及本地工具中继 |
| Windows HAPI Runner | 管理安装在 Windows 的 provider |
| WSL keeper | 启动指定发行版并维持客户端连接；应用由 Linux systemd 管理 |

任务调用系统 `wscript.exe` → `task-bootstrap.js` → `task-launcher.ps1`。监督、重试与退出码传播由 PowerShell 实现。直接用 PowerShell 的 `-WindowStyle Hidden` 仍可能在脚本执行前打开 Terminal，因此保留这个很小的系统脚本宿主入口。

Windows Codex 的执行环境需要交互用户会话；检查 daemon 的 initialize 成功不足以验证其沙箱工具可用。后台任务异步启动，各自等待与重试，不阻塞 Windows 登录。

## 目标机配置

把 [services.example.json](services.example.json) 复制到 Windows runtime root，命名为 `services.json`，再填写目标机值。例如：

```json
{
  "windowsRunner": {
    "workspaceRoot": "D:\\Projects",
    "apiUrl": "http://127.0.0.1:3006",
    "environment": {}
  },
  "wsl": {
    "distribution": "Ubuntu-Example",
    "linuxUser": "developer",
    "units": ["hapi-hub", "hapi-runner"]
  }
}
```

这里只写已安装的 Linux 服务；省略 `units` 时只检查该用户的 systemd manager。目录必须存在。没有代理需求时无需增加代理配置；`environment` 可显式覆盖 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY`，其他环境正常继承。配置留在目标机，不随源码、补丁或分发包提交。WSL-only 安装只需要 `wsl` 段。

## 首次安装与现有安装更新

Windows Native 首次接线见 [Windows Desktop 迁移](WINDOWS_DESKTOP_MIGRATION.md)。先完成目标组件本身的安装、认证和服务定义。`install-background-services.ps1` 是**现有整套安装的更新器**，会检查既有 Native/Runner 任务与状态；它不安装 HAPI、Codex、WSL 或 provider CLI。

在部署所有者的独立管理员 PowerShell 中，从分发包根目录更新：

```powershell
./install-background-services.ps1 -RuntimeRoot 'D:\Services\HAPI' -ValidateOnly
./install-background-services.ps1 -RuntimeRoot 'D:\Services\HAPI'
```

Native 的切换会暂时断开 Desktop，执行入口必须独立于它。只更新 Runner 与 WSL keeper 可用 `-ServicesOnly`；只安装或更新 keeper 用 `install-wsl-services.ps1`。窄范围更新会拒绝需要同时更换共享启动器的变更。安装失败会恢复之前的任务、入口文件和原运行状态，结果写入 runtime 下的 `background-services/install-result.json`。

## 可选 ARSO

需要正常重启后自动恢复用户服务时，可以使用 Windows ARSO。它自动准备临时登录凭据，成功登录后删除，并由 Winlogon 锁定会话。未加入域的机器在用户正常重启或关机再开机后可适用，前提是此前没有注销；不能据此保证突然断电后的恢复。域或 Entra 管理设备的条件不同，本包 helper 会拒绝直接套用。详见 [Microsoft ARSO 文档](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/winlogon-automatic-restart-sign-on--arso-)。

`configure-arso.ps1` 默认选择 `RequireBitLocker`；磁盘保护关闭时停止并要求明确选择。只有主动接受相应策略时才用 `-Mode Always`，脚本不更改磁盘加密。如果目标机已有永久 Autologon，迁移时明确添加 `-RemovePermanentAutologon`：关闭永久登录、删除保存的 LSA/注册表密码及本套旧锁屏任务，过程不读取密码。没有这项迁移需求时不传该参数。

```powershell
./configure-arso.ps1 -RuntimeRoot 'D:\Services\HAPI' -Mode RequireBitLocker
```

不需要自动恢复用户会话的机器可跳过 ARSO，手动登录后启动上述任务。直接部署在 Linux 服务器上的服务使用 Linux 的开机启动，不依赖 ARSO。

## 验收

分别检查任务和实际服务：Runner 控制接口、所选 systemd units、Native initialize 身份、Desktop backend 连接与工具中继。锁屏保留用户会话，注销会终止这些用户任务。整机重启验收应在目标机器准备好后进行，不能以“当前任务 Running”代替。

网络、代理和凭据可选方案见 [网络与环境](NETWORK_AND_ENVIRONMENT.md)。
