# Linux / WSL 运行维护

按需部署 Hub、Runner、Editor、认证或 Termix；它们的依赖、运行数据和 unit 保存在目标 Linux 的持久目录。服务不依赖下载临时目录、开发 checkout 或另一个版本的复制目录。

## 启动

每个应用使用独立 systemd unit、明确的 WorkingDirectory/ExecStart 和目标机私有环境。需要用户 unit 随发行版启动时启用该用户的 linger。Windows 部署另外配置 WSL keeper，见 [Windows 服务](WINDOWS_SERVICES.md)；systemd 自身不负责从 Windows 启动发行版。纯 Linux 主机使用自己的正常开机启动方式。

HAPI Native 连接已有 daemon。可选 Codex watchdog 通过官方 version/start 接口确保 daemon 可用，复用其控制 socket。Windows daemon 使用独立 supervisor。不要用 Hub/Runner 各自创建一个后端代替共享连接。

启动脚本通过私有环境文件取得 PATH、provider setup、公共 URL 与可选代理，具体入口见 [恢复脚本](wsl/README.md)。DSH 和 Termix 恢复组件分别选用，不因为安装 HAPI 就自动启用。网络模式与代理建议见 [网络与环境](NETWORK_AND_ENVIRONMENT.md)。

## 更新与回退

1. 保存当前 commit、补丁序列、锁文件和私有服务参数；对需要持久化的数据库做一致性备份。
2. 在新目录构建需要的 release，检查成功后切换服务入口。凭据与对话状态继续使用原私有目录。
3. 同一个 Runner 只由一种机制管理。更新 manager 后，已存在的 provider wrapper 仍可能使用旧 executable；按原生 resume 能力切换空闲会话并核对其原生 ID 和设置。
4. Editor 内部符号不匹配时停止旧补丁注入，按目标版本重新核对。回退前端不回退共享凭据库中新注册的设备。
5. 共享 backend 更新独立执行，分别验证 daemon 身份、Desktop 工具/连接以及 HAPI 读取；只看某个进程存活不足以确认整个链路。

目标机器需要自行验证所选服务和计划中的重启恢复。历史验收记录描述其特定版本，不能代替目标机检查。
