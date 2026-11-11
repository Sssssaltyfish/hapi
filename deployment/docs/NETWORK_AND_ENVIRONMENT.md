# 网络与运行环境

所有例子都使用假想数据。先选择需要的组件和主机，再填写目标机的路径、账户、端点与认证；本包不提供源机器的配置副本。

## 两条网络路径

- 手机/浏览器 → Tailscale → Web 服务：Tailscale Serve 为 tailnet 提供 HTTPS/TCP 转发。目标 Web 服务须先能从运行 Tailscale 的机器访问。参见 [Serve 文档](https://tailscale.com/docs/reference/tailscale-cli/serve)和 [Windows unattended 模式](https://tailscale.com/docs/how-to/run-unattended)。
- Agent → 模型提供方：使用 provider 的认证及其出站网络配置。可以直接连接，也可以使用所在地网络需要的代理。Tailscale 转发服务可用并不代表模型端点可达。

FlClash、Mihomo、CPA、NVM 和某个具体 Linux 发行版都不是这套转发服务的必需组件。接收者已经有可用出站网络时无需替换它。

## 按实际需求选择出站方式

| 环境 | 配置方式 |
| --- | --- |
| 可以直连模型服务 | 保持 provider 默认连接，不增加代理变量 |
| 已使用桌面代理 | 在其官方客户端中配置用户自启；需要 ARSO 后可用时确认锁屏状态下核心已启动 |
| 需要独立于桌面的代理 | 可选择独立代理核心及支持该核心 API 的管理面板，作为独立组件维护订阅、凭据和启动顺序 |
| 使用模型网关 | 只在对应 provider 的私有配置中填写端点与凭据；先核对协议、模型名及权限 |

不要把客户端的控制 API 地址当作代理流量端口，也不要假定某个 GUI 能连接外部核心。若考虑 FlClash，其外部控制配置本身不表示可以接管另一个独立 Mihomo 核心；按所用版本的官方能力核对。代理也不需要改动 Tailscale 的正常服务入口。

Windows Runner 从私有 `services.json` 的 `environment` 读取显式覆盖，其余环境照常继承。Linux 的私有 `service-env.sh` 可以设置所需 PATH、provider 凭据入口和代理。无需代理时保持为空。已有代理 bypass 应保留，并覆盖实际使用的 loopback/内部服务端点。

例如只为某台测试机器设置 `HTTPS_PROXY=http://proxy.example.test:18081`；这是假想端点，必须替换或删除，不能作为默认值分发。含密码、订阅或 token 的值不放进共享脚本或 Git。

## Windows 与 WSL

Windows 访问 WSL 的服务通常可走 localhost 转发；WSL 访问 Windows 在默认 NAT 模式下通常使用宿主地址，在 mirrored 模式下可以使用 localhost。两者不能一概视为同一 loopback。采用 SSH/现有 daemon 控制通路时沿用该通路，不为每个 daemon 额外暴露公网端口。参见 [微软 WSL 网络说明](https://learn.microsoft.com/en-us/windows/wsl/networking)。

先分别验证 Web 上游、daemon、模型端点。WSL 的服务环境来自 unit/私有配置，不应依赖用户偶然打开一次交互 shell；systemd linger 也不会自行从 Windows 拉起发行版，Windows 部署需配置 keeper。

## 认证与可选组件

每台机器使用自己的 Codex/provider 登录和 HAPI 认证配置。共享 Passkey 是可选的本地部署集成，各应用仍使用各自登录页，见 [共享认证](SHARED_AUTH.md)。只安装 HAPI 时可以沿用 HAPI 自身认证。DSH、Termix、Editor 和门户均可单独选择，不应因为分发包包含其补丁就自动安装。
