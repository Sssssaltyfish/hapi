# Codex Native：daemon 协议与手机 Web 覆盖审计

审计日期：2026-11-03。范围是 HAPI 的 **Codex Native Hub/Web 路径**，同时标明 Runner/shared、桌面宿主及 HAPI 自身实现的边界。本文不将接口数量作为完成率：历史分页、文件上传等产品功能会组合多个接口；反过来，Hub 能转发某个请求，也不代表手机 Web 已提供操作界面。

## 结论与优先级

当前 Native 路径已经覆盖聊天、双向分页历史、用户消息目录及定位、模型与推理强度、本轮新增的 Plan/Goal、基本审批、队列发送/取消/立即引导、附件、文件读取、会话创建/改名/归档。最值得继续补充的是：

| 优先级 | 手机端需求 | 准确协议入口 | 当前差距与实现约束 |
|---|---|---|---|
| P1 | 搜索一段旧对话并直接跳转 | `thread/searchOccurrences` | Native 没有消息搜索。服务端返回 snippet、UTF-16 匹配区间、turnId、itemId、turnCursor，可复用现有定位与分页能力；限单个 paginated thread 的可见用户消息、助手的部分及最终回答，不是工具输出全文搜索。两端只读调用成功。 |
| P1 | 在手机上完成阻塞任务的授权或表单 | 服务端请求 `mcpServer/elicitation/request`、`item/permissions/requestApproval` | Web 当前只处理命令审批、文件修改审批、requestUserInput；其他请求仅提示需桌面。Hub 有通用回复通道，但缺少对应 UI、参数校验和完整决策语义。OAuth/URL 类交互仍可能需要浏览器或宿主。 |
| P1 | 修改、调整尚未执行的排队输入 | `thread/queue/update`、`thread/queue/reorder` | 已有列表、删除、发送、立即引导，缺编辑与排序。必须使用 daemon 的 submission ID，并处理被另一客户端消费后的冲突；不要用删后重发模拟编辑。两方法在完整导出中属于实验接口。 |
| P1 | 发现并停止遗留后台任务 | `thread/backgroundTerminals/list`、`thread/backgroundTerminals/terminate`，按需 `thread/backgroundTerminals/clean` | 已展示历史命令卡片，不等于管理仍在运行的进程。列表两端只读调用成功；终止/清理未执行验证。此方法族也不等于完整交互终端。 |
| P2 | 从历史某处开分支、恢复归档 | `thread/fork`、`thread/list` 的 archived 参数、`thread/unarchive` | Native UI 仍缺分支和归档恢复。压缩上下文有独立的 `/compact` 入口。 |
| P2 | 在多个聊天间找到未加载的内容 | `thread/search` | HAPI 当前列表搜索只筛选已取回摘要，不调用此接口。协议声明 substring/full-text query 并返回 thread+snippet，但本轮未核定其具体索引字段、分词与全量正文范围。WSL 只读调用成功；另一版本一次 15 秒未返回，需先验证大历史库性能。 |
| P2 | 明确设置生效时间、速度档和权限配置 | `thread/settings/update`、`turn/settings/update`、`permissionProfile/list` | Native 当前设置主要作用于后续 turn。运行中 turn 的设置是另一实验接口；serviceTier、命名权限配置仍未暴露。权限配置列表两端读取成功，设置是否允许取决于实际配置、模型及宿主约束。 |
| P2 | 在多个客户端间同步已读、整理项目和分区 | `thread/readState/update`、`thread/metadata/update`、`threadSection/list/create/update/delete`、`thread/section/move` | HAPI 的本地已读标记、目录分组，不等于 daemon 的原生持久状态。已读更新要求 expectedRevision；项目归属与分区排序应保留服务端 ID、并发冲突和空值语义。 |

## 输入区与会话命令

`/compact` 启动原生上下文压缩。`/recap` 在 Native 和 managed 路径中使用与 CLI 一致的临时摘要线程：读取有界的近期用户可见历史，保留原顺序，使用原会话的模型、provider 和目录，在禁用工具、MCP、hooks、plugins、skills 和 memories 的 ephemeral helper 上执行结构化生成。摘要及可选下一步使用用户语言，完成后脱离临时线程，不改动原对话，也不创建持久会话。源会话发生变化、超时或取消时，丢弃结果并中断已知的 helper 轮次后清理。旧主机不支持该流程时返回升级说明，不再使用 sampling 或原始摘录兜底。CLI 没有独立的 recap RPC；`thread/sample` 是另一项公开实验 API。`getConversationSummary` 只有预览和会话元信息，不用作摘要替代。`/approve` 展示当前线程中已观察到的自动审查拒绝，用户核对具体动作后可以请求一次重试。`/usage` 通过 `account/usage/read` 和 `account/rateLimits/read` 读取用量与额度，两项可用性分别显示。

输入区的上下文占用取自最近一次实际 token 用量和 provider 报告的窗口上限。点击在百分比与 token 数之间切换。账户总用量和 Goal 的累计消耗另行展示。

本轮已经补齐 Native Hub/Web 的命令链路，不能继续列为“daemon 支持、Native 完全没接”。新实现通过 Native commands 路由执行操作，不把 `/plan`、`/goal` 当普通模型提示词。

| 用户操作 | 原生入口与确认方式 | 当前边界 |
|---|---|---|
| `/plan` 开启，输入区 Plan 按钮退出 | `collaborationMode/list` 发现预设，`thread/settings/update` 提交，`thread/settings/updated` 确认 | 作用于后续轮次。点击补全与发送命令走同一入口。`/plan off` 会按原文提交提示词 `off`。 |
| `/plan <任务>` | 先确认模式，再使用既有 native 队列提交一次任务；附件继续走既有输入链路 | 强制作为排队输入，不插入正在执行的 turn。公开 queue 请求没有每条消息的 collaborationMode 字段，因此不承诺与其他客户端同时改模式时的消息级隔离。 |
| `/goal` 查看，`/goal <目标>` 设置 | `thread/goal/get/set/clear`，写入带 `origin:user` | 暂停、恢复和清除通过目标旁的按钮操作。命令后的文字均作为目标，包括 `pause`。预算、用量和耗时取自 daemon。 |
| 状态条及命令发现 | 按当前线程读取 presets、完整 feature 分页及 goal；监听 settings/goal 更新或清除后刷新 | 功能未启用或状态不可确认时明确不可用；不自动修改全局 feature 配置。刷新失败不把已确认操作重新显示成失败。 |

计划正文复用原生 plan item 的消息投影，并消费 `item/plan/delta` 增量。Goal feature 必须按被操作线程检查；Plan 不能仅因旧 `collaboration_modes` 条目为 removed 就被禁止。已确认排队成功后的自动启动失败会单独显示；提交结果不确定时不会自动重发。上述覆盖由新源码链路确认，最终隔离协议与 UI 验收结果另见本轮交付记录。

## 基准、取证方法与置信范围

从连接中的两个 daemon 对应二进制分别读取版本，并执行以下离线导出；导出命令不启动 app-server，也不创建或恢复会话：

```sh
codex --version
codex app-server generate-json-schema --out schema-default
codex app-server generate-json-schema --experimental --out schema-full
```

| 本次取样版本 | 默认导出的客户端请求 | 包含实验接口后的客户端请求 | 服务端请求 / 通知 |
|---|---:|---:|---:|
| Windows 上的 `0.166.0-alpha.5.1` | 106 | 179 | 11 / 85 |
| WSL 上的 `0.165.0-alpha.1.2` | 106 | 176 | 11 / 85 |

两端只读取样均返回 Plan / Default 预设；`goals` 为 stable、enabled=true、defaultEnabled=true，`collaboration_modes` 为 removed、enabled=true。全局和各自被检查的已加载线程均核对了 feature 状态；这两个线程的 `thread/goal/get` 成功返回 goal:null，证明读取可用，不证明任意写入或所有线程都允许该功能。

本次取样中，较新版本多出 `account/gcp/setup`、`accountSession/list`、`accountSession/switch`。这是**两个被测版本的差异**，不能据此认定是操作系统专有能力。共同方法的请求定义中，`hooks/list` 在较新版本新增 threadId；`thread/fork` 存在描述差异。两个版本的客户端方法集合除此以外一致，不代表所有嵌套类型、响应字段和运行行为一致。

“默认导出”只说明不加 `--experimental` 时是否出现。它不是稳定性承诺；“完整导出存在”也不是权限、feature flag、模型、账户或宿主能力的保证。HAPI 已使用的队列、项目、部分历史读取与线程设置本身就有实验字段或方法，因此不能把“实验”统一解释成不可使用。

证据分三层：

- **运行读取已证实**：枚举 Plan 预设、全局及指定已加载线程的 feature 状态、Goal get、会话内搜索、后台终端列表、权限配置列表、provider capability 读取；另一个版本的跨线程搜索仅记录超时。
- **源码链路已核实**：检查 Native Hub 路由、服务、Web adapter、消息投影、事件处理，以及当前 Runner/shared 入口。没有把旧 launcher 中的代码自动视为当前已接通能力。
- **协议存在，写入未测**：除本轮独立实现另有验收说明的 Plan/Goal 外，本审计未执行设置、fork、压缩、删除、回退、终止进程、修改配置、安装插件、账户切换等操作。新增功能需要独立验收写入及并发语义。

读取核查仅使用现有连接，没有创建会话、恢复会话、发送模型输入或重启服务。feature 枚举按 nextCursor 读取至结束；只查第一页可能漏掉功能。指定已加载 threadId 时，feature 状态按该线程刷新后的配置计算，包含项目配置，所以全局值不能代表每一个线程。

## 已覆盖能力与容易误判的边界

| 能力 | Native 当前覆盖 | 对应接口或实现 | 不应据此推断的能力 |
|---|---|---|---|
| 会话目录及创建 | 已接通 | `thread/list`、`thread/read`、`thread/start`；`project/list/create/read/update`、`thread/metadata/update` 与目录通知、文件夹读取 | 项目改名、会话换组及回到无工作区已接通。项目排序、删除和持久分区管理另计。 |
| 连接与设置状态 | 已接通 | `thread/resume`、`thread/settings/updated`；断连重连与 SSE | `thread/read` 元数据并不提供完整 threadSettings；不能靠一次 metadata read 判断当前 Plan 模式。 |
| 发送、引导、停止 | 已接通及间接实现 | `thread/queue/add/list/delete/start`、`turn/steer`、`turn/interrupt` | 不需要直接使用 `turn/start` 才能实现发送。队列由 daemon 调度，HAPI 仅在需要时显式启动；不能把 turn/start 未直接调用算作功能缺失。 |
| 历史分页与精确读取 | 已接通 | `thread/turns/list`、`thread/items/list`、`thread/items/read` | 没有使用 `thread/timeline/list` 不等于没有历史时间线。现有读取与定位已经组合实现该产品能力。 |
| 用户消息目录和跳转 | 已间接实现 | Hub 按 turn summaries 扫描用户消息，Web 缓存目录与定位游标 | 目录不搜索助手回答或工具输出，也不是跨线程全文索引。 |
| 模型、推理强度 | 已接通 | `model/list`、`thread/settings/update`，确认通知后更新 UI | serviceTier、运行中 turn 的配置、命名权限 profile 不是自动获得。 |
| 审批与问题回答 | 部分已接通 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput` 的回复；部分异步问题通过普通消息答复 | 通用服务端请求转发、raw reply 路由不等于 Web 理解所有 11 类请求。 |
| 改名、归档 | 已接通 | `thread/name/set`、`thread/archive`，经 Native session middleware | Native 菜单中的删除、恢复、固定、导出并未因共用 SessionChat 自动可用。 |
| 文件浏览与附件 | 已接通、部分间接实现 | `fs/readFile/readDirectory/getMetadata`；附件使用 `fs/createDirectory/writeFile/copy/remove` | 写文件方法已用于附件，但没有通用代码编辑器。文件系统复制能力已被使用，不能整体标记为“未接”。 |
| Skills / Apps / Plugins | 发现与引用已接通 | `skills/list`、`app/list`、`plugin/list`、`mcpServerStatus/list`；输入转换为 typed mention/skill | 列表与引用不等于安装、卸载、登录、切换账户或任意工具调用 UI。 |
| 命令执行 | 仅有内部有限用途及历史显示 | `command/exec` 用于工作区身份读取；模型命令卡片来自 items | 不等于手机端拥有任意 shell，也不等于实现了 `process/spawn` 或后台终端控制。 |
| 子代理与工具执行 | 主要为读取显示 | 原生 items 投影为工具、协作和子代理状态卡片 | 展示已有子代理活动不等于 Web 提供创建、任意控制其他线程或动态工具宿主。 |
| 语音 | HAPI 自身已有转写/语音相关服务 | 通用 Web 语音入口与其他后端服务 | 不等于接通 `thread/realtime/*` 的原生持续会话、音频输出及 handoff。 |

Native API adapter 对未分类的会话操作默认拒绝；Hub middleware 也阻止 Native ID 落入旧 Runner 控制路由。因此，共用按钮、类型定义或旧 session REST endpoint 的存在，不能作为 Native 已接通的证据。

## 搜索的三个不同范围

1. **HAPI 会话列表筛选**：浏览器对已取回的会话摘要做匹配，字段包括标题、summary、工作树标签、路径、机器标签、flavor 和 ID。它不会因为输入关键字而调用 daemon 全局检索，也不能找到尚未取回的全部正文。
2. **HAPI 用户消息目录**：从 turn summaries 提取用户消息预览，按扫描预算逐页补齐；用于阅读导航。现有目录和跳转值得复用，不应为了搜索另造一份无上限的完整 transcript 缓存。
3. **daemon 搜索**：`thread/search` 提供跨线程结果和 snippet，但本轮不承诺其确切索引字段；`thread/searchOccurrences` 明确搜索单个 paginated thread 的可见用户消息和助手的部分/最终回答，使用不区分大小写的字面子串，按消息时间顺序分页。后者有原生结果锚点，适合先做手机会话内“查找下一处”。

跨线程搜索还需验证多来源、归档筛选与游标，避免把“当前无命中”或一次超时误报成接口不支持。一次 15 秒超时不足以归因于操作系统、权限或特定索引实现。

## 其余差集：按用途决定是否值得接入

上面的优先级表已经覆盖主要聊天控制缺口。其余接口按用途归组，不将完整 schema 中的每个方法都当作手机待办：

| 方法或方法族 | 当前分类 | 价值与边界 |
|---|---|---|
| `review/start` | Native 未接 | 可做明确的“审查未提交改动 / 分支 / commit”操作。普通 review 提示词不是同一协议；inline 为默认，detached delivery 已弃用，独立审查线程应先 thread/start 再 inline review。会启动模型工作，本轮未测。 |
| `thread/memory/read`、`thread/memoryMode/set`、`memory/status/reset` | Native 未接；部分实验 | 可用于查看与选择记忆使用；thread/memory/read 要求线程已启动或恢复。全局 reset 属于维护动作。 |
| `thread/attachment/add/list/remove`、`thread/attachmentOwner/list`；`fs/watch/unwatch` | 上传和读取已有间接实现，原生附件元数据与 watch 未接 | 若需要跨客户端附件清单、归属或实时文件刷新，再接相应接口。附件已使用 fs/writeFile，不等于有通用代码编辑器，也不能标为“不支持附件”。 |
| `fuzzyFileSearch` 与 `fuzzyFileSearch/sessionStart/sessionUpdate/sessionStop` | 单次搜索已接，session 增量接口未接 | Native 的裸 `@` 读目录，`@keyword` 已直接调用 fuzzyFileSearch。仅在大仓库输入延迟有证据时评估增量接口；不是聊天正文搜索。 |
| `skills/config/write`、`skills/extraRoots/set`、`plugin/install/uninstall/reconcile`、`marketplace/add/remove/upgrade`、`config/*` | 已有发现与引用；管理未接 | 适合独立设置页，涉及 daemon/项目配置。插件安装、MCP 重载，与引用一个已启用 skill/app 是不同产品操作。 |
| `mcpServer/oauth/login`、`mcpServer/resource/read`、`mcpServer/tool/call`、`mcpServer/event/stream/start/stop` | 未提供完整 MCP 客户端 | 模型工具调用可显示，不等于 Web 能任意手动调用。需要登录、账户选择、工具宿主、权限和订阅生命周期。 |
| `thread/realtime/start/stop/listVoices/appendAudio/appendSpeech/appendText` | 原生 realtime 未接；实验 | 手机有语音价值，但需要音频 transport、播放、会话结束和 handoff。现有 HAPI 转写服务不能算作这些接口已接通。 |
| `hooks/list`、`modelProvider/capabilities/read`、`configRequirements/read` | 未有专门设置/诊断 UI | 可先用于能力发现与解释功能不可用；provider capability 读取两端已验证。 |
| `project/read/update/move/delete/import`、`thread/metadata/update` 的 projectId | 项目部分接入 | 可创建、列出、改名并重新指定聊天归属。`project/move` 负责项目排序，HAPI 未接入排序或删除项目。项目 root、线程 cwd、Git worktree 是不同概念。 |
| `process/spawn/writeStdin/resizePty/kill`、`command/exec/write/resize/terminate`、`thread/shellCommand` | 宿主执行控制；Native 仅有限内部使用 | 完整交互终端是另一产品功能。Runner 终端不能算成 Native daemon 的 process API 已接。 |
| 账户登录/切换、provider setup、`userVerification/*`、`remoteControl/*`、`environment/*`、`windowsSandbox/*`、`externalAgentConfig/*` | 账户、平台或宿主管理 | 可能需要本机浏览器、验证设备、平台权限或另一个远控体系，不列为手机聊天首批缺口。账户三个新增方法属于本次版本差异。 |
| 预测/采样、`thread/inject_items`、`thread/approveGuardianDeniedAction`、elicitation 计数、mock、诊断、反馈、rollout 压缩及账户额度消费动作 | 实验、专门授权、编排或维护用途 | 需要逐项确认用户场景与宿主契约；不能因导出中可见就做成通用聊天按钮，也不计作手机聊天覆盖率的缺分项。 |

“导出对话”是有价值的 HAPI 产品缺口，但本轮 schema 没有专门的 conversation export 方法；可组合分页读取生成产物。HAPI pin、通知、定时发送和 scratchlist 同样不应被虚构成一一对应的 daemon 方法。

## 服务端请求：手机真正能完成哪些交互

两个版本的完整 schema 都有 11 类 ServerRequest：

- Native Web 已实现答复：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`。
- 有手机价值但未实现对应交互：`item/permissions/requestApproval`、`mcpServer/elicitation/request`。
- 需要专用宿主或兼容处理，不能做通用“批准”按钮：`item/tool/call`、`account/chatgptAuthTokens/refresh`、`attestation/generate`、`currentTime/read`、旧式 `applyPatchApproval`、`execCommandApproval`。

Hub transport 会记录请求并产生内部事件，Native 订阅再按 thread 过滤；不能假设缺少线程归属的宿主请求也已送达手机。raw reply 路由能发送 result/error，当前 Web projector 对送达但不支持的请求生成提示，而 adapter 限制可答类型。补齐 UI 时必须按每类响应 schema 实现，不可把所有请求压成 accept/decline，也不可让手机 UI 充当登录凭据刷新或任意动态工具的默认宿主。

## 源码索引与复核方式

这些链接均为仓库内源码，不包含部署地址、绝对本地路径、会话 ID 或凭据：

- [Native 路由](../hub/src/web/routes/codexNative.ts)、[Native service](../hub/src/codexNative/service.ts)、[transport](../hub/src/codexNative/transport.ts)：RPC 调用、连接、事件、设置确认及请求回复。
- [Plan/Goal 命令处理](../hub/src/codexNative/threadCommands.ts)、[命令语法](../shared/src/codexThreadCommands.ts)、[Web 状态与事件](../web/src/codex-native/useNativeThreadCommands.ts)、[状态条](../web/src/codex-native/NativeThreadCommandsBar.tsx)：本轮新增链路。
- [Native middleware](../hub/src/codexNative/sessionMiddleware.ts)：改名/归档与旧 session 控制路由隔离。
- [项目与创建](../hub/src/web/routes/nativeCreation.ts)、[附件](../hub/src/codexNative/attachments.ts)、[文件](../hub/src/codexNative/files.ts)、[引用与发现](../hub/src/codexNative/mentions.ts)：多 RPC 组合的间接实现。
- [Web adapter](../web/src/codex-native/nativeSessionApiAdapter.ts)、[Native 页面](../web/src/codex-native/NativeSessionPage.tsx)、[事件消费](../web/src/codex-native/useNativeThread.ts)、[消息投影](../web/src/codex-native/projectNativeItems.ts)：用户实际能操作、看到和答复的范围。
- [用户消息目录](../hub/src/sync/conversationOutline.ts)、[列表搜索](../web/src/lib/sessionListSearch.ts)、[通用聊天 UI 的 Native 分支](../web/src/components/SessionChat.tsx)：区分现有间接能力与未接功能。
- [当前 Runner 入口](../cli/src/codex/runCodex.ts)、[shared 控制](../cli/src/codex/shared/root.ts)、[shared runtime](../cli/src/codex/shared/runtime.ts)：对照 Runner 已有能力，不把它并入 Native 覆盖率。
- 官方入口：[App Server 文档](https://learn.chatgpt.com/docs/app-server)。版本差异以本次对应二进制导出的 ClientRequest、ServerRequest、ServerNotification 及具体 Params/Response 为准。

复核新版本时，重新导出默认及实验 schema，比较方法集合与具体字段，再检查 Hub → Web adapter → UI → 事件确认的完整链路。静态字符串命中只能作为定位线索；通用转发、旧 Runner 代码、桌面已有按钮，以及 schema 枚举成功，都不能单独证明 Native 手机端端到端可用。
