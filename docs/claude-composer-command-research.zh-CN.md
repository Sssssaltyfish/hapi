# Claude Code 四个命令：官方能力、安装版与 HAPI 接入判断

核查日期：2026-11-04。官方资料采用查询时的在线文档；本地安装版通过 `claude --version` 确认是 **2.1.309**。下面区分文档支持、安装版命令目录、实际零模型调用测试与尚未验证的完整功能，不把“命令存在”当成“任何环境都能执行”。本文不包含部署地址、真实会话或凭据。

## 适用程度

| 命令 | 官方含义 | 安装版 / headless 实证 | 对手机 Web 的判断 |
|---|---|---|---|
| `/focus` | 终端的简洁显示模式：保留最近提示、工具摘要与最终答复；要求 fullscreen renderer。Remote Control 有 on/off 形式，VS Code 也有独立显示设置。[官方命令](https://code.claude.com/docs/en/commands)、[Fullscreen](https://code.claude.com/docs/en/fullscreen) | headless 初始化目录列出了 focus，但隔离执行 `/focus on` 返回 `/focus isn't available here yet`；result 为 success，却是 **0 turn、0 API ms、0 成本**。所以目录命中和 success 都不能作为真正生效的证明。 | **值得做 HAPI 自己的视图控制**。复用现有工具展示偏好与折叠状态，仅改变显示，不改变模型任务或删除历史；不应把发给 headless 的 `/focus` 当作实现。 |
| `/deep-research <问题>` | 官方内置 dynamic workflow，分派检索、读取与交叉核对，输出带来源的研究报告；要求 WebSearch 可用。workflows 官方明确支持 `claude -p` 和 Agent SDK。[Workflows](https://code.claude.com/docs/en/workflows) | 二进制内有内置研究流程，headless 初始化目录也列出 deep-research。**未执行真实研究**，没有验证当前 provider 的 WebSearch、Workflow 授权、后台进度或完整报告质量。 | **有条件值得接入**。优先发现并执行原生命令，呈现 Workflow 权限、运行与失败状态。不能因为 HAPI 使用 SDK 就判为不支持，也不能对任意兼容 API 承诺可用。 |
| `/insights` | 分析本机近期 Claude Code 会话并生成 HTML，适用于任意 plan/provider；分析走当前 provider，消耗模型用量，cloud sessions 不支持。[使用模式报告](https://code.claude.com/docs/en/costs#analyze-your-usage-patterns) | 安装版为 built-in prompt command，headless 初始化目录有 insights；另有 allow_insights 策略检查及 workspace 前提。**未运行生成器、未分析真实历史**。 | **适合作为低频报告操作**。可优先尝试原生命令与结果文件呈现，完整生成仍需隔离验收。不应因未测试生成就宣称 SDK 不支持，也不应在打开菜单时自动分析全机历史。 |
| `/btw [问题]` | 不进入主对话历史的侧问，可在主回合运行时独立回答；只用已有上下文，无工具。终端采用独立 overlay。[交互模式](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw) | headless 初始化目录**没有 btw**；隔离执行返回 `/btw isn't available in this environment.`，0 turn、0 API ms、0 成本。二进制将斜杠命令定义为 local-jsx。 | **用户价值高，但需要单独适配**。不能作为普通 user message 投进主队列，否则无法保证“不打断、不入主历史”。本次没有证明 HAPI 的 SDK 封装支持原生侧问。 |

## SDK / headless 的准确边界

官方 SDK 以初始化消息的 `slash_commands` 发现当前会话可执行命令。命令可能受环境和策略限制；不存在的名称与已知但不可用的内置命令不是同一情况。自 2.1.274 起，未知命令可能变成带提示的普通模型输入，花费一个模型回合。因此 HAPI 不应靠盲目透传和“是否报错”探测功能，也不能把任意 `/name` 当成功执行的管理指令。[SDK 命令发现与分发](https://code.claude.com/docs/en/agent-sdk/skills#commands-in-agent-sdk-sessions)

本次额外使用 stream-json 的 **initialize 控制请求**取得安装版目录；这与公开 SDK 的 system/init 消息不是同一种 envelope，但同样是当前进程提供的目录。隔离环境中目录有 44 项，四个目标中出现 deep-research、focus、insights，缺少 btw。focus 的执行结果进一步说明：初始化目录只是接入线索，仍须检查命令的原生结果含义。

`/deep-research` 是官方内置 workflow，不是必须由用户安装的第三方 `/deep` skill。官方列出的 workflows 供应面包括付费计划、Anthropic API 和部分云提供商；Pro 需要在配置中启用。任意自定义兼容 API 网关不因此获得同等支持保证。SDK 与 `-p` 不显示 TUI 的 workflow 确认对话，而使用通常的工具权限评估；可由匹配 Workflow 名称的权限规则或宿主 `canUseTool` 等正常途径批准。是否能真正运行还取决于 WebSearch、权限和功能配置。不要为接入该命令自动启用全局 bypass。[Workflow 审批与 SDK](https://code.claude.com/docs/en/workflows#approve-the-plan-before-it-runs)

需要另行区分 **ultracode 提示词关键词**：官方规定这一显式选择只对真实人工输入生效；SDK 发送时要标记 `origin: {kind:"human"}`。普通 `-p` prompt、未标人工来源的 SDK 消息及自动任务，不因出现关键词就启用该路径。这是关键词规则，不能推导出直接调用 `/deep-research` 或 Workflow 在 SDK 中一律不可用。[关键词的来源规则](https://code.claude.com/docs/en/workflows#where-the-keyword-works)

## 四条能力的回退设计

1. **Focus：前端能力。** HAPI 应持有自己的显示偏好，并能切回完整视图；不要修改 Claude 的 reasoning effort、工具权限或 prompt。这是实现相近用户体验，不能标称远端 Claude terminal 已切换 Focus。
2. **Deep research：能力发现后调用原生 workflow。** 首先核对当前进程命令目录与 Workflow/WebSearch。若不可用，可提供名称清楚的普通研究任务或自定义 research skill，复用已配置的检索工具；不能承诺它拥有官方流程的交叉验证、并行度或相同报告质量。模型无法检索时应保留明确的不可用状态，不以纯记忆回答假装联网研究完成。
3. **Insights：原生报告与 HAPI 统计分开。** 官方报告会读取运行命令的主机上的 Claude Code 会话，单次最多处理 200 个尚未分析的会话并跳过很短的会话；报告有最新文件及时间戳版本，不自动包含其他设备或 claude.ai 的会话。手机端应显示数据范围与报告结果。HAPI 自己的消息/用量统计可以另做，但不能冒称相同的 Claude insights 分析。[报告范围与生成方式](https://code.claude.com/docs/en/costs#analyze-your-usage-patterns)
4. **BTW：独立侧问通道。** 首选有可验证契约的原生侧问接口；若没有，可设计显式的独立只读问答面板，从主对话生成上下文快照，禁止工具和主历史写回。这样仍是 HAPI 的侧问实现，不自动等价于 Claude 原生 `/btw` 的上下文、缓存和计费语义。把 `/btw` 文本发回主任务不算回退。

当前安装包内部确实含 `askSideQuestion()` 和 `side_question` control-request 线索，具有独立响应、取消和进度处理；另一宿主分支要求注册 onSideQuestion callback。查询时的公开 TypeScript reference 未列出该方法，HAPI 当前自带 SDK 封装也未提供对应方法。这说明原生存在可研究接缝，**不构成当前公开 SDK 支持承诺，也未证明普通 headless worker 可直接使用**。后续应针对选定 SDK/CLI 版本做接口契约、并行性与“不写主历史”验收，再决定是否适配；本次没有调用该内部通道。[公开 SDK 类型参考](https://code.claude.com/docs/en/agent-sdk/typescript)

## 本次实际做了什么

- 读取已安装版本和 CLI 帮助；检查安装包内四命令的注册类型、环境条件与 headless 分发限制。
- 在隔离配置和空项目中初始化一个临时 headless 进程。关闭非必要流量，使用占位密钥，并将模型 API 指向不提供模型服务的本地地址；没有读取真实会话。
- 仅执行 focus 与 btw 两个可零模型返回的检查，记录结果文本、回合数、API 时间与成本，均为零；进程退出，没有操作正在运行的 Claude 会话。
- 未运行 insights 生成、deep research、WebSearch 或内部 side_question；没有验证真实 provider 权益和完整模型行为，没有修改产品实现或生产配置。

建议顺序：**先做 HAPI Focus 视图；再做按能力发现的原生 deep-research；insights 放报告工具入口；BTW 作为单独接口课题，避免一个看起来可用但污染主对话的输入框按钮。** 这是依据接入成本与语义完整性的产品判断，不是 Claude 官方优先级。
