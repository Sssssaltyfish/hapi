# Claude Code 四个命令：官方契约与分派路径

核查日期：2026-11-04。**能力结论以官方文档和版本化实现分支为依据，不能用本机是否有额度、一次调用成功或失败来判定产品是否支持。** 本文对照 Claude Code 2.1.309 的命令注册与 worker 分派，以及 Anthropic 发布的 Agent SDK 0.3.309、0.3.317 包；后者分别标记配套 CLI 2.1.309、2.1.317。实现细节仅适用于所核版本，不代替公开 API 的长期承诺。

## 可直接复述的结论

| 命令 | 官方能力及入口 | 实现依据与触发条件 | HAPI 的适用程度 |
|---|---|---|---|
| `/focus` | fullscreen 终端的简洁视图；Remote Control 提供 on/off，VS Code 使用独立显示设置。[命令说明](https://code.claude.com/docs/en/commands)、[Fullscreen](https://code.claude.com/docs/en/fullscreen) | 有交互 UI 与非交互处理器两条路径。后者的特定 unavailable 文本由提交来源条件直接返回，**不是额度检查结果**；满足支持的宿主条件后才解析参数、更新显示状态。 | 这是显示能力，HAPI 可复用自己的工具展示偏好实现。不能把 Claude 终端的 Focus 状态当作 HAPI 页面已切换。 |
| `/deep-research <问题>` | 官方内置 dynamic workflow；要求 WebSearch，workflows 明确支持 CLI、`-p` 和 Agent SDK。[Workflow 文档](https://code.claude.com/docs/en/workflows) | 内置流程注册为 workflow；启用状态、WebSearch 和 Workflow 工具权限是前提。SDK 不弹终端确认面板，但仍进行工具权限评估。额度可能影响实际模型工作完成，不能据此否定命令或 SDK 支持。 | 值得优先对接原生命令与 workflow 状态。自定义兼容 API 是否实现所需检索和工具能力，不能从协议兼容或命令存在推出。 |
| `/insights` | 分析运行主机的近期会话并生成 HTML；任意 plan/provider 可用，分析使用当前 provider 并消耗模型用量；不用于 cloud sessions。[官方范围与用量](https://code.claude.com/docs/en/costs#analyze-your-usage-patterns) | 注册为 built-in prompt command，有 `allow_insights` 策略及 workspace 前提；直接调用才进入生成器，技能预加载不生成报告。它不是因依赖交互 JSX 而被 headless 统一挡住的命令。 | 适合作为显式报告操作。支持分派与完整报告生成是不同结论；真实分析仍可能遇到数据、权限、provider 或额度错误。 |
| `/btw [问题]` | 主任务之外的无工具侧问，不写入主历史，也不打断正在进行的工作。[官方侧问语义](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw) | **斜杠 UI 入口和 SDK 控制请求是两条路径**：local-jsx 命令在 headless 分派中被挡住；普通 headless worker 却另有 `side_question` 请求处理分支。不能从前者推出“headless 没有侧问能力”。 | 需要专门的侧问适配与独立显示。底层分支可作为原生接入依据，但公开高层 SDK 类型尚未声明该方法，需明确版本契约；不能把普通主输入当作 BTW。 |

## `/focus`：那条 unavailable 的具体原因

2.1.309 的非交互 Focus 处理器先检查一个纯上下文条件，再解析 `on` / `off`。将压缩符号换成含义明确的名字后，逻辑如下：

```text
isBridgeSubmission = dispatchedOverBridge === true
                  OR submissionVerifiedSlackHumanTurn === true

if submittedOnLocalStdin === true AND NOT isBridgeSubmission:
    return "/focus isn't available here yet"

parse on / off / empty argument
set focus/default override
publish apply_flag_settings with briefTranscript
if effective value is held by managed viewMode:
    report the managed value
else:
    report enabled/disabled
```

实际压缩实现的 guard 名为 `ain`，依赖 `kF`；两者只读取上面三个布尔字段。这一返回发生在参数解析和设置更新之前，**没有余额查询、限额判断或模型请求**。因此可以确定：该版本中这句固定文本表示提交来源/宿主路径不适用，不能解释成“当前没有额度”。这不说明其他模型操作永远不受额度影响，也不把这些内部上下文字段当作应由客户端伪造的绕过开关。

交互终端还有独立的 `local-jsx` Focus 处理器：先检查 presentation。非 fullscreen 不能开启正常 Focus，会提示切换 renderer；若已有 briefTranscript 状态，还可清理并关闭它，若由 viewMode 配置强制开启则提示修改配置。fullscreen 分支才按当前状态切换，并处理保存的偏好及远端显示同步。官方另规定 Remote Control 的 on/off 只作用于当前会话，不改变保存的选择；VS Code 的 Focus 属于扩展自己的设置。因此应按实际宿主区分终端、Remote Control、SDK 和 HAPI，而不是给 `/focus` 一个脱离宿主的统一支持布尔值。[官方宿主范围](https://code.claude.com/docs/en/commands)

## `/btw`：headless 斜杠拒绝不等于 worker 没有侧问

2.1.309 中有三条需要分开的实现路径：

1. **斜杠 UI 分派。** `/btw` 注册为 `local-jsx`。通用分派器在 `command.type === "local-jsx" && isNonInteractiveSession` 时直接生成 unavailable 结果，`shouldQuery:false`，不进入普通模型回合。这是界面/入口限制，不是余额判断。
2. **普通 SDK/headless worker 的控制请求。** 输入处理器明确处理 `request.subtype === "side_question"`：去重 request ID，拒绝正在关闭的会话，创建独立取消控制器，并异步调用侧问执行器。它传入实时消息读取、当前主回合是否运行、以及必要时重建上下文的函数；这个分支不是先把 `/btw` 当普通消息入队。
3. **另一条 REPL/Remote Control 桥接分支。** 同样接受 `side_question`，但要求宿主注册 `onSideQuestion` callback。该分支缺 callback 会返回不支持；**不能把这个要求泛化为普通 worker 的必要条件**。

普通 worker 的侧问执行器优先复用可用上下文，否则使用 fallback 构造函数；上下文仍为空时可以返回 `response:null`。进入侧问推理后，所核实现使用独立取消/超时与进度消息，最多一回合、拒绝工具、跳过主 transcript 写入，并以 `threadHistory:false` 管理侧问历史。正常模型请求仍可能遇到 provider、认证、额度、重试或拒答；这些运行失败与“没有侧问分派分支”是不同问题。

Anthropic 发布的 **SDK 0.3.309 与 0.3.317 的 `sdk.mjs` / `core.mjs` 都含 `askSideQuestion()`**，它发送 `side_question` 并处理 response、synthetic、取消和可选 history。但是这两个版本的公开 `sdk.d.ts` / `core.d.ts` 未声明 `askSideQuestion`，查询时的公开 TypeScript reference 也未给出该方法。因此准确结论是：**所核版本的底层 worker/发布包实现存在原生通道，不能把它说成不存在；同时不能把未列入公开类型和文档的方法承诺为稳定高层 SDK API。** HAPI 当前自带 SDK 封装没有对应适配，端到端接通仍需实现。[SDK 0.3.309 发布元数据](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.309)、[SDK 0.3.317 发布元数据](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.317)、[公开类型参考](https://code.claude.com/docs/en/agent-sdk/typescript)

## Deep research 与 Insights 的条件

`/deep-research` 在所核安装包中包含研究 workflow 脚本及注册代码，不是必须另行安装的第三方 `/deep` skill。官方规定 workflows 可在 `-p` / SDK 中运行；`disableWorkflows`、管理配置和 `CLAUDE_CODE_DISABLE_WORKFLOWS` 会使其不可用，Pro 另需启用配置。启动仍经 Workflow 工具权限：宿主可通过正常 `canUseTool` 等途径作答。**这些是功能配置与工具授权条件，不能与账户剩余额度混为一谈。** 实际研究中的检索或模型调用失败，才需要按实际错误判断原因。[启用与禁用](https://code.claude.com/docs/en/workflows#turn-workflows-off)、[SDK 启动权限](https://code.claude.com/docs/en/workflows#approve-the-plan-before-it-runs)

`ultracode` 关键词是另一种触发方式。官方只把真实人工来源视为显式选择，SDK 使用 `origin: {kind:"human"}`；普通 `-p` prompt 或自动消息不因出现该词就走这条路径。此限制不能套用成“直接 `/deep-research` 或 Workflow 在 SDK 中一律不支持”。[关键词来源规则](https://code.claude.com/docs/en/workflows#where-the-keyword-works)

`/insights` 的 prompt 生成器在 `isSkillPreload` 时只返回说明；直接执行才收集、分析会话并生成报告。注册处的 `disableModelInvocation:true` 也不能读成“报告不消耗模型用量”：官方明确分析走当前 provider 并计费。报告只覆盖运行主机的数据，单次最多处理 200 个尚未分析会话并跳过很短的会话，不自动包含其他设备或 claude.ai。代码的分派条件不能证明某个账户一定能完成报告；同样，某次分析失败也不能证明命令不支持 SDK。[官方 Insights 范围](https://code.claude.com/docs/en/costs#analyze-your-usage-patterns)

## HAPI 的接入与回退判断

- **Focus：**复用 HAPI 自己的显示偏好，允许切回完整视图，不改变模型任务、推理强度或持久历史。是否能转发一个远端终端的 Focus 设置，与 HAPI 页面自身是否有简洁视图是两个功能。
- **Deep research：**优先原生 workflow，按实际会话发现功能和工具授权；若只能做普通研究任务或自定义 skill，应使用不同名称和明确语义，不能承诺相同流程或报告质量。
- **Insights：**提供低频、显式的原生报告操作与结果呈现。HAPI 自己的统计可另做，但不冒称运行主机的 Claude Insights。
- **BTW：**优先评估已确认存在的原生 `side_question` 通道，并固定版本、处理响应与取消、保持独立显示且不写主历史。若最终使用自建上下文快照问答，应明确是 HAPI 的侧问实现；普通主队列输入不是等价回退。

### 手机端侧问交互建议

在读长回复时，用户可以选中文字点「侧问」，也可以在输入区选 `/btw`。两种入口都打开同一个底部面板。直接发送 `/btw 为什么先做这一步？` 则打开面板并开始回答。原聊天保持滚动位置，主输入框的草稿、引用和附件继续保留。

面板显示「侧问」、可选的所选原文、独立输入框和流式答案。主任务继续运行时，面板里的「停止」只取消本次侧问。收起后用一个小按钮返回当前侧问；同一会话最多保留一个面板，默认只保留到离开会话。需要主任务采纳答案时，点「引用到主输入框」生成一张可编辑的引用卡，由用户决定是否发送。

适配器必须能隔离主任务、禁用工具并取消侧问。仅能读取已完成轮次的后端可以提供「基于上一个已完成轮次提问」，应在提问前显示这个范围。无法提供侧问的后端不应将问题悄悄改走普通发送或 steer。

## 证据与判断边界

官方资料是产品能力依据；实现核查用于解释入口和条件。版本化证据来自发布包的 `sdk.mjs`、`core.mjs`、类型声明及 CLI 内嵌模块；核查的 2.1.309 CLI 文件 SHA-256 为 `4d704a8aecbe038affa3000f498ae17c1b4f753add8facb8764120affc99b658`。压缩符号和代码位置只用于复核该版本，不是 HAPI 应依赖的 API 名称。

对同一 SHA-256 文件，可按以下字节偏移复核关键分支；这只定位该版本的内嵌源码，不能套用到升级后的二进制：

| 复核点 | 字节偏移及可检索标记 |
|---|---|
| Focus 来源 guard | `247502716`，`function ain(` 及紧邻的 `kF` |
| Focus 固定不可用文本 | `263174835`，`/focus isn't available here yet` |
| local-jsx 的 headless 拒绝 | `270912788`，`r.type==="local-jsx"&&o.options.isNonInteractiveSession` |
| 普通 worker 的侧问分派 | `277934434`，`request.subtype==="side_question"` |
| 侧问上下文与执行器 | `277190505`，`async function zRn(` |

发布包可从上述官方 registry 元数据中的 tarball 获取，只读取 `sdk.mjs`、`core.mjs` 及类型声明即可核对 SDK 对照，不需要安装或运行模型。

先前本机观察只作为旁证：隔离 headless 目录列出 deep-research、focus、insights，未列 btw；Focus 与 BTW 返回了对应的不可用文本。**本报告不使用这些观察来判断额度、账户权益、一般 SDK 支持或完整功能成功率。** 本次补查没有发送模型任务，没有分析真实历史，没有运行研究或侧问，也没有修改产品实现或生产配置。尚不能由实现单独确定的内容包括真实 provider 的工具能力、账户额度、API 运行结果、未来版本契约和 HAPI 新适配的完整交互效果。
