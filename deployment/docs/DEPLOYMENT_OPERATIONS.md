# 部署与构建

当前应用源、上游基线、补丁数量及部署脚本 commit 均以 `PATCH_MANIFEST.json` 为准。部署脚本源位于 [ops/seia-deployment](https://github.com/Sssssaltyfish/hapi/tree/ops/seia-deployment)；分发文件由 manifest 固定到具体 commit，不能把浮动分支当作包版本。

## 目标环境

按需选择 Windows Native、Windows Runner、Linux/WSL、Editor、Termix 或共享认证。路径、账户、发行版和网络只写进目标机私有配置。分发中的示例是虚构的。代理与模型网关不是 Tailscale Web 入口的前置要求，见 [网络与环境](NETWORK_AND_ENVIRONMENT.md)。

Windows 示例布局是 `D:\Services\HAPI`：共享启动脚本位于根目录，Native 位于 `windows-native/`，runner 可执行文件位于 `package/bin/`，运行状态保存在独立目录。Linux 可采用 `~/.local/share/hapi`，`current` 指向完整 release，`cli-current` 指向编译版 CLI，`bin/` 存放启动脚本。开发仓库和运行目录互相独立。

## 构建

按 [PATCHES.md](PATCHES.md) 克隆固定上游并顺序应用补丁，再构建实际需要的 Hub/Web/CLI。`deployment/build_release.py` 可从完整 commit 导出临时源码树，在其中按锁文件安装与构建；`--repo`、`--git`、`--bun` 和 `--node-bin-dir` 均可指定，没有源机器路径默认值。完成后清除临时目录，发布产物带 SHA-256 manifest。

更新服务时切换完整 release，不要求保留某个旧版本的复制 checkout。用户数据、认证和 provider 配置继续使用目标机私有目录。

## 启动与更新

Windows Native 首次安装和现有整套安装更新是两个入口，分别见 [迁移指南](WINDOWS_DESKTOP_MIGRATION.md)和 [Windows 服务](WINDOWS_SERVICES.md)。Linux 恢复脚本按显式组件选项安装，见 [wsl/README.md](wsl/README.md)。共享认证使用当前本地集成补丁及应用自己的登录页，旧的机器专用 bootstrap 不随包交付。

更新 Runner 后，仅凭 session active 不能判断正在工作。切换前读取实际生成、工具、后台任务、待答审批/问题、队列和本地所有权；空闲且可恢复的会话通过已有 resume 路径切换，保持原生 ID、模型、推理等级和权限。manager 重启不会更新仍存活的旧 wrapper。原生 backend 切换从独立进程执行，不能依靠即将重启的 Desktop 会话完成收尾。

## 技能与配置

编译版 HAPI CLI 维护 `$HAPI_HOME/bundled-skills/hapi-visualize`。根据各 provider 的技能发现机制链接到这份共享目录；使用源模式时可链接 checkout 的 `skills`。路径按运行 Agent 的账户填写。详见 [当前可视化指南](https://github.com/Sssssaltyfish/hapi/blob/a273585eb62477f2b5dea1e2d8a4bd97795f0464/docs/guide/visualizations.md)。

`services.json`、`service-env.sh`、Native `config.json` 和状态目录都属于安装私有内容。这里只交付 `.example` 配置、公共脚本和补丁；不导出已部署机器的配置对象。

## 打包与记录

维护一个固定打包工作区即可，没有 WSL 镜像要求。以 `deployment/finalize-handoff.py --source <打包目录> --output-dir <输出目录>` 生成固定文件名压缩包；程序比较最高压缩级别 PPMd 与 LZMA2 后保留较小结果。包内时间戳用于区分更新。

旧部署方案在 Git 历史中保留以说明演进。当前维护的说明与脚本已替换旧入口；不能从旧 commit 标题或历史验收记录推断当前任务类型。服务生命周期的修复和验证边界见 [审查结论](SERVICE_LIFECYCLE_AUDIT.md)。
