# 私有服务部署 Handoff

本包提供精确上游 commit、顺序补丁、部署参考脚本及校验清单，用于在另一台机器重建所选服务。没有完整修改后应用 checkout、依赖目录、运行数据或源机器私有配置。

目录、账户、发行版、域名和网络示例均使用假想数据。接收者选择需要的组件，再填写目标机器参数。无需安装与源环境相同的代理、模型网关或全部 provider。

## 从这里开始

| 需求 | 入口 |
| --- | --- |
| 当前部署方式、构建与更新 | [部署操作](DEPLOYMENT_OPERATIONS.md) |
| 检查故障、监测重连、查看本机维护信息 | [service-doctor](WINDOWS_SERVICES.md#日常检查) |
| Windows 登录任务与可选 ARSO | [Windows 服务](WINDOWS_SERVICES.md) |
| 网络、代理与环境差异 | [网络与环境](NETWORK_AND_ENVIRONMENT.md) |
| 应用上游、补丁顺序和构建 | [PATCHES.md](PATCHES.md)、[PATCH_MANIFEST.json](PATCH_MANIFEST.json) |
| Windows Desktop 接入同一 Codex backend | [迁移步骤](WINDOWS_DESKTOP_MIGRATION.md)、[连接原理](WINDOWS_CONNECTION.md) |
| HAPI Native、项目过滤和多个主机 | [CODEX_HAPI.md](CODEX_HAPI.md)、[当前 Native 指南](docs/guide/codex-native.md) |
| Linux/WSL 生命周期 | [WSL 运维](WSL_OPERATIONS.md)、[恢复脚本](wsl/README.md) |
| 手机编辑器 | [EDITOR.md](EDITOR.md) |
| 各应用独立登录页和共享 Passkey | [SHARED_AUTH.md](SHARED_AUTH.md)、[SHARED_PASSKEYS.md](SHARED_PASSKEYS.md) |
| 可选 AGY 模型网关 | [配置与迁移](wsl/AGY_GATEWAY.md) |
| 可选 DSH / Termix | [DSH_TERMIX.md](DSH_TERMIX.md)、[SNIPPETS.md](SNIPPETS.md) |
| 媒体与静态缓存 | [MEDIA_CACHE_PREVIEW.md](MEDIA_CACHE_PREVIEW.md)、[STATIC_CACHE.md](STATIC_CACHE.md) |

## 版本与内容

HAPI、Editor、Termix 的上游 commit、应用补丁与发布版本在 `PATCH_MANIFEST.json` 中。认证等本地集成保持独立补丁，安装者可以按需选用。

Windows backend 由用户登录任务启动。可选的 Desktop 任务在后端就绪后打开桌面。需要无人值守正常重启恢复时可选 ARSO。Linux 服务可独立部署。

`PATCH_MANIFEST.json` 和 `WINDOWS_REFERENCE_MANIFEST.json` 标明当前源码与分发文件。`VALIDATION.md`、`STABLE_HISTORY.md` 及按功能命名的增量说明记录各自日期/commit 的历史验收；其中“本轮”“已部署”和旧补丁计数仅指当时版本，不能作为当前安装步骤。需要重建当前结果时从当前 manifest 的基线顺序应用全部补丁，不叠加旧包的单独补丁。

先核对 `SHA256SUMS.txt`。运行参数、凭据、Passkey 数据库、Codex home、会话内容和真实主机资料留在目标机。私有认证数据需要接收者自己备份。包内 `PACKAGED_AT.txt` 记录压缩时间；对外只保留固定名 `service-deployment-handoff.7z` 最新版。
