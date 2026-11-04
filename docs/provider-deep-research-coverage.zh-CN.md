# 各 Provider 的 Deep Research 入口与 HAPI 接入范围

核查日期：2026-11-04。这里的 provider 指 HAPI 的代理后端，而非只指模型供应商。能力判断依据官方文档、上游作者源码及 HAPI 分派代码；没有运行付费研究任务，也不以本机余额或一次调用失败判断支持。HAPI 代码核查基线为 `5ee680a76229851a289673557283bc500b03854c`；正在并行开发的其他功能不构成本报告的验证结果。

**Claude Code 与 Copilot CLI 都有官方原生研究入口，名称分别为 `/deep-research` 与 `/research`。** Codex、Antigravity、DSH、OpenCode 也能承担研究任务，但本次找到的入口分别涉及搜索编排、子代理、技能或插件，不能把同名斜杠提示词视为同一种原生流程。Gemini Deep Research API 则是独立的服务入口。

## 短矩阵

“接入工作量”评估的是在现有 HAPI 路径上补齐发现、执行和结果呈现所需的相对工作；不承诺实际工期或研究质量。“未找到”限定于下列文档与实现范围。

| 后端 | 真实能力与来源 | 当前 HAPI 路径及适用程度 | 前置、用量与接入工作量 |
|---|---|---|---|
| **Claude Code** | 官方内置 dynamic workflow `/deep-research <问题>`；文档明确 workflows 支持 CLI、`-p`、Agent SDK。需要 WebSearch 与 Workflow 工具授权。[官方 workflows](https://code.claude.com/docs/en/workflows) | HAPI 的 Claude stream-json 封装可提交命令，并读取启动元数据中的 slash catalog；应复用原生 workflow，再补状态、授权和报告呈现。没有从“可发送文本”推导完整研究已验收。 | **低至中**。按 plan/provider 的真实权益、功能开关与工具能力启用；Pro 有额外启用要求，组织配置可禁用。消耗实际模型/检索用量；兼容 API 并不自动具备所需工具。详见 [Claude 四命令报告](claude-composer-command-research.zh-CN.md)。 |
| **Copilot CLI** | 官方 `/research TOPIC` 生成带引用的报告，覆盖本地代码、可访问的 GitHub 仓库与网页。**当前官方 ACP 文档明确列出 `/research`**，普通 prompt 的单个文本块是正确执行入口。[研究说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/research-with-copilot-cli)、[ACP 契约](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server#using-slash-commands) | 已走 `copilot --acp --stdio`，resolver 保留 `/research`，launcher 使用单 text block，符合公开接法。尚需把会话实际广告的命令集作为功能依据，补报告入口与权限交互；硬编码菜单不足以证明所装版本可执行。 | **低至中**。有效 Copilot plan；组织用户需启用 CLI policy。按实际模型与方案计量，研究涉及多步工作；ACP 为 public preview。不需要为了调用原生 research 换成独立外部研究 API。 |
| **Codex** | 官方 Codex CLI 提供 cached/live web search；可以通过任务和技能编排研究。所核 CLI/app-server 接口未找到同名内置 `/deep-research`。Work 桌面的 Deep research 插件另有安装入口及账户限制。[官方搜索与 Work 入口](https://developers.openai.com/codex/web-search) | Runner 的 prompt/skill 与 Native 的队列输入可以承载研究任务；没有已接通的通用 app-server research method。Work 插件存在不证明 HAPI 的 Codex daemon 已能调用该插件。 | **中**：若做技能式研究，要定义检索、引用、进度与报告语义，仍使用所选 Codex 后端与工具权限。**高**：另做 Responses API 研究服务，需独立凭据、计费、任务管理；见下文迁移限制。 |
| **Antigravity / AGY** | 内置 `research` 子代理针对**代码库研究、导航和结构探索**；没有在所核命令目录找到同名网页 Deep Research 内置入口。可自建技能并以斜杠调用。[子代理](https://antigravity.google/docs/subagents)、[技能迁移](https://antigravity.google/docs/migration/workflows-to-skills) | HAPI 逐轮执行 `agy -p … --output-format stream-json`，目前没有专门研究分派。普通研究要求或已安装技能可作为候选，但需另核该 CLI 的 headless 技能、工具和结果契约。不能从 App 子代理说明直接承诺 HAPI 已完整支持。 | **中**。依赖 AGY 实际模型、浏览/检索工具、技能安装与 headless 能力。旧 workflows 已按官方时间表退出，新增方案应采用 skills；模型用量随代理和子任务增加。 |
| **DeepSeek Harness / DSH** | 官方采用插件组合；未在所核核心命令文档发现内置 `/deep-research`。社区 **Insight Mode** 插件提供主代理澄清、研究计划确认和并行 worker，属于独立作者扩展。[官方命令服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/commands/README.md)、[插件作者说明](https://github.com/ZG2017/dsh-plugin-insight-mode) | HAPI 有自建 `_hapi/dsh/command` 桥接，对广告出来的原生命令可 `list/execute`。研究插件还可能通过 persona/tools 而非 slash 启动；必须检查插件实际组成和 ACP 可用的提问、工具、子代理交互，不能只安装后显示一个 `/deep-research`。 | **中至高**。示例插件要求 DSH `0.2.1-alpha.2+`，选中正确 profile/bundle 并处理版本兼容。主/worker 模型用量分别产生；作者明确其预算是提示性约束，运行状态不跨进程持久化。 |
| **OpenCode** | 官方支持自定义命令和插件；官方生态列出的 **opencode-tavily** 由 Tavily 维护，为代理注册 CLI skill，可执行 `tvly research`。这是插件/技能调用 Tavily 服务，不能称 OpenCode 自带 `/deep-research`。[命令文档](https://opencode.ai/docs/commands/)、[生态](https://opencode.ai/docs/ecosystem/)、[插件作者说明](https://github.com/tavily-ai/opencode-tavily) | HAPI 使用 OpenCode ACP；已安装插件可在上游运行时提供工具。HAPI 自定义命令目前是读取内容后展开为普通文本，不能保证等价于原生 `session.command`。另外扫描目录仍是单数 `command`，当前官方文档使用复数 `commands`，需按版本核对发现路径。 | **中**。作者支持 v1.18.29+ 与 v2，但配置键分别为 `plugin` / `plugins`；需 Tavily CLI、登录或 API key。Tavily 研究服务用量与 OpenCode 所选模型用量分开，插件并不继承模型供应商的研究额度。 |
| **Gemini CLI / Gemini API** | CLI 扩展目录列出的 `gemini-deep-research` 是 **allenhutchison 的第三方扩展**，其 manifest 启动 MCP server；Google 官方 Deep Research 是 **Interactions API agent**。[扩展目录](https://geminicli.com/extensions/)、[作者 manifest](https://github.com/allenhutchison/gemini-cli-deep-research/blob/main/gemini-extension.json)、[Google API](https://ai.google.dev/gemini-api/docs/deep-research) | **当前 HAPI 不可启动 Gemini CLI**：registry 保留 tombstone，只允许旧会话继续查看。因此不能靠增加菜单完成接通。若新增 API 研究后端，应作为独立集成，不能假定发送给 AGY 就使用同一 API agent。 | **高**。扩展作者要求付费 Google AI API key，Interactions API 与标准 Gemini 调用配额分开。API 路径需要独立认证、异步任务、状态/失败/取消及报告呈现。Gemini CLI 官网的迁移公告仅明确 unpaid tier 与 Google One 用户，不应扩大成全部企业/API 产品停用。 |

## 几个会影响设计的协议细节

**Copilot 应先发现，再发送。** 官方规定 `available_commands_update` 在创建/加载会话后发送，后续通知完整替换旧集合；没有按需获取该集合的方法。只有在实际集合中的命令才会执行原生流程；不受支持的 slash 会成为普通模型提示词。HAPI 当前保留原文、用一个文本块发出，已经符合调用形状；后续需要确认实际会话的 catalog、避免合批或额外文本改变命令形状，并把不支持反馈给用户。[官方 ACP 命令规则](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server#discovering-available-commands)

**DSH 的命令面与研究 persona/tools 是不同入口。** 官方 registry 可由交互适配器执行插件命令，而普通 ACP 自动化不自动带这个命令面。HAPI 自己的桥接已补了 `list/execute`，但示例 Insight Mode 是 host-side 插件，通过 persona、`submit_insight_plan` 和 `dispatch_insight_worker` 实现研究，并非声明一个标准 `/deep-research` 就完成接入。需核 profile、版本和用户提问/确认通道。[官方命令边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/commands/README.md)、[插件实现说明](https://github.com/ZG2017/dsh-plugin-insight-mode)

**OpenCode 有原生命令 API，但 HAPI 的文本展开不是这条路径。** 官方 SDK 的 `session.command` 能执行命令；原生命令模板还具有参数、模型/agent 等语义。HAPI 的展开只把正文与 `User arguments` 拼接成提示词，因此带原生模板语法的研究命令需要专门校验，不能宣称所有自定义命令等价兼容。Tavily 插件的 tool/skill 路径则可以独立于 HAPI 的 Markdown 命令扫描器存在。[官方 SDK](https://opencode.ai/docs/sdk/)、[官方命令模板](https://opencode.ai/docs/commands/)

**Google 研究 API 是长任务服务。** 当前官方示例使用 `interactions.create(agent="deep-research-preview-04-2026", background=True)`，再通过 `interactions.get(id)` 查询；另有 Max 版本、流式更新与预览中的协作规划。HAPI 若选择该路径，要保存真实任务标识、处理后台状态和引用报告。它不是 Gemini CLI/AGY 的普通 prompt，也不应借用“已有 CLI 登录就有 API 研究额度”的假设。[官方 Deep Research API](https://ai.google.dev/gemini-api/docs/deep-research)、[扩展作者的配额说明](https://github.com/allenhutchison/gemini-cli-deep-research)

**OpenAI 旧 Deep Research API 示例需迁移。** 当前官方页面已将旧专用模型示例保留为历史参考，并指向模型停用公告；新方案应按 Responses API、web search、file search、remote MCP 的配置重新评估。不能把旧 `o3-deep-research` / `o4-mini-deep-research` 示例作为现在可直接复制的接法，也不能将独立 API 项目和计费当作 HAPI Codex daemon 的现成功能。[官方迁移页](https://developers.openai.com/api/docs/guides/deep-research)

## 建议优先级与对用户的表述

1. **先补 Claude 与 Copilot 的原生入口。** 保留各自真实名称、按会话发现可用性，显示授权、进度、报告与失败；这两家已有直接的官方 workflow/ACP 依据，工作更接近补齐现有适配。
2. **将 Codex / AGY 的自定义研究能力命名为技能或研究任务。** 可以实现统一的引用报告要求，但先确认工具、headless 能力和实际安装状态，再决定菜单是否可用。
3. **将 OpenCode Tavily、DSH Insight Mode 列为可选扩展。** 明示作者、版本、安装和额外服务成本；避免自动安装后假定研究预算受硬上限保护。
4. **将 Gemini / Responses API 作为独立研究后端立项。** 前置条件、凭据、计费和任务生命周期均超出现有 slash 转发，接入工作量最高。

对外可说明：“目前优先对接 Claude 与 Copilot 的官方研究流程；其他后端可以通过搜索、技能或插件研究，但安装条件、工具来源和计费方式不同。菜单中的‘研究’只有在当前后端确认具备对应能力时才会启用。”

## HAPI 代码复核位置与置信范围

以下均为仓库相对位置，便于随版本复核：

| 范围 | 关键实现 |
|---|---|
| Claude | [`sdk/query.ts`](../cli/src/claude/sdk/query.ts)、[`metadataExtractor.ts`](../cli/src/claude/sdk/metadataExtractor.ts)；命令与 worker 细节见 [专项报告](claude-composer-command-research.zh-CN.md)。 |
| Copilot | [`copilotBackend.ts`](../cli/src/copilot/utils/copilotBackend.ts) `buildCopilotAcpArgs`；[`slashCommands.ts`](../cli/src/copilot/utils/slashCommands.ts) 的 research passthrough；[`copilotRemoteLauncher.ts`](../cli/src/copilot/copilotRemoteLauncher.ts) 单 text block。 |
| AGY | [`agyHeadlessDriver.ts`](../cli/src/agy/headless/agyHeadlessDriver.ts) `buildAgyHeadlessArgs`。 |
| DSH | [`dshRemoteLauncher.ts`](../cli/src/dsh/dshRemoteLauncher.ts) capability、catalog 和 execute；[`permissionBridge.ts`](../cli/src/dsh/utils/permissionBridge.ts) 对公开 registry 的桥接。 |
| OpenCode | [`opencodeBackend.ts`](../cli/src/opencode/utils/opencodeBackend.ts)、[`slashCommands.ts`](../cli/src/opencode/utils/slashCommands.ts)；[`common/slashCommands.ts`](../cli/src/modules/common/slashCommands.ts) 的目录发现。 |
| Gemini | [`commands/registry.ts`](../cli/src/commands/registry.ts) `removedGeminiCommand`。 |

对上述“官方有该能力”“HAPI 当前使用哪条分派路径”置信度高；对未做端到端运行的报告呈现、当前账户权益、实际安装插件、未来上游兼容性不作成功承诺。没有找到同名内置命令的后端，仍可能通过新的官方入口或扩展获得研究能力；本报告给出的检索范围和来源用于复核这些变化。
