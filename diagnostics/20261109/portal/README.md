# 导航页与 WSL 转发排查

2026 年 11 月 9 日，Windows 实测两次显示 `Ubuntu-26.04` 为 `Stopped`。启动一次只读 WSL 检查后，导航页恢复 HTTP 200，其余应用随后开放端口。检查进程退出后，发行版再次显示 `Stopped`。这可以解释间歇性的端口拒绝和刚启动时的网关错误。客体日志确认完整关机，未记录可归因的发起者。

## 复现时间线

以下时间均为 Asia/Shanghai。

| 时间 | 观察 |
| --- | --- |
| 02:51:04 | 上一个长时间运行的 WSL 实例到达 `shutdown.target` 和 `poweroff.target`。 |
| 03:06:06–03:06:28 | WSL 启动，随后再次到达 `shutdown.target` 和 `poweroff.target`。DSH 就绪检查在这次停止中收到 SIGTERM。 |
| 03:12:38 | 日志记录新 boot ID 的第一条消息，用户服务随后启动。03:13:25 用户服务再启动一次，属于同一内核 boot ID。 |
| 03:16:56 前 | Windows `wsl --list --verbose` 显示 `Ubuntu-26.04` 为 `Stopped`。 |
| 03:16:56 | 只读命令唤醒发行版。同一内核 boot ID 下，导航页已返回 200，Editor 路由一度返回 500，Editor socket、DSH `3000`、HAPI `3006` 尚不可用。 |
| 03:17:01–03:17:14 | 导航页、Editor socket 健康检查和 HAPI 均返回 200。Editor 路由、Seia 会话检查和 DSH 对无会话请求返回 401。DSH HTTP 已就绪，systemd 仍在执行要求连续就绪 30 秒的 `ExecStartPost`。 |
| 03:17:52 | 探测进程已经退出，Windows 再次显示 `Ubuntu-26.04` 为 `Stopped`。 |

`/var/lib/systemd/linger/igna` 已存在。`/etc/wsl.conf` 启用了 systemd，Windows `.wslconfig` 使用 `Mirrored` 网络模式，未发现 `vmIdleTimeout` 设置。检查 195 个 Windows 计划任务，未找到动作直接运行 WSL 或参数中引用 WSL 的任务。也未发现专用的 WSL 保活单元或常驻 `sleep infinity` 进程。Windows 下未找到可用于确认停止发起者的 Lxss/WSL 事件日志。观察结果与发行版在 Windows 客户端退出后停止一致，Desktop 是否曾持有唯一的连接仍待独立验证。

## 服务实况

| 服务 | 启动入口与工作目录 | 端口和结果 |
| --- | --- | --- |
| `remote-portal.service` | `/usr/sbin/nginx`，配置 `/home/igna/.local/share/remote-shell/nginx.conf`，工作目录 `/home/igna` | `127.0.0.1:18080`。首页、`/shell/` 返回 200，`/dsh/`、`/auth/`、`/hapi/` 返回 302。 |
| `nginx.service` | 系统 nginx，`/usr/sbin/nginx` | `:80` 返回 200。该端口属于独立的系统 nginx。 |
| `mobile-editor.service` | `/home/igna/editor-deployment/start.sh`，运行自带 Node，工作目录 `/home/igna` | `/home/igna/editor-deployment/code-server.sock` 的 `/healthz` 返回 200，受保护的导航路由在无会话请求下返回 401。 |
| `termix.service` | `/home/igna/termix-deployment/start.sh`，工作目录 `/home/igna/termix-deployment/source`，运行现有 NVM Node | `127.0.0.1:30001` 返回 200，导航页的 `/shell/` 返回 200。 |
| `dsh-web.service` | `/bin/bash` 执行 `/home/igna/.local/lib/dsh-web/start-with-proxy.sh`，工作目录 `/home/igna`，运行现有 NVM Node | `127.0.0.1:3000` 冷启动期间拒绝连接，就绪后无会话返回 401。`ready-reset.py` 要求 30 秒连续就绪。近期失败日志记录启动后检查进程因 SIGTERM 退出。 |
| `seia-auth.service` | `/home/igna/.local/share/hapi/build-tools/bun/bin/bun` 执行 `/home/igna/seia-auth/server.ts`，工作目录 `/home/igna/seia-auth` | `127.0.0.1:18082`，`/health` 返回 200，`/verify` 无会话返回 401。 |
| `hapi-hub.service` | `/home/igna/.local/share/hapi/bin/start-passkey-hub.sh`，实际工作目录是新 release 的 `hub`，实际运行新路径 Bun | `127.0.0.1:3006` 启动后返回 200。 |

旧 HAPI `source` 与旧 Bun 入口均已移除。筛查了相关活动 systemd 单元、服务启动脚本、导航配置和 Seia 安装链接，未发现这些服务还指向被移除的位置。Windows 侧另外核对 Tailscale Serve 仍为 `443 → 18080`、`8443 → 3000`、`8444 → 3006`，在 WSL 启动后无代理的导航页及 HAPI 探测均返回 200。

若需消除这段冷启动空窗，最小变更范围是让一个独立于 Desktop 的 Windows 进程持续持有 WSL 会话，并验证它在 Desktop 重启后仍能保持发行版处于 `Running`，随后分别检查导航、DSH 和 HAPI 的转发端口。这次排查期间没有修改服务、计划任务或转发配置。

## 随后应用的修复

父任务安装了 `Seia-WSL-Services` Windows 计划任务，使用新运行目录的隐藏启动器，持续运行 `wsl.exe --distribution Ubuntu-26.04 --user igna --exec /bin/sleep infinity`。它在用户登录时启动，独立于 Desktop；实际网页服务仍由 systemd 管理。微软文档明确说明 [systemd 服务本身不会维持 WSL 实例存活](https://learn.microsoft.com/en-us/windows/wsl/systemd)。

停止其他 WSL 诊断命令后，03:19:11–03:20:21 从 Windows 连续采样 8 次：公开导航、HAPI health、Termix 和认证 health 始终 200；Editor 与 DSH 始终返回正常的未登录 401。保活任务和其 WSL 客户进程持续运行。Tailscale Serve 规则保持原样。
