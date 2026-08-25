# `@deepseek-ai/dsh-llm-model-router`

[English](README.md) | 中文

函数插件，通过 agent loop（智能体循环）的 `agent/request` waterfall 在两个配置的提供方层级之间逐轮路由。部署方命名一个快速路由（如 `deepseek-v4-flash`）与一个重型路由（如 `deepseek-v4-pro`）；每轮开局的请求消息由确定性的文本策略打分，分数越过升级阈值之前该轮始终由快速层级服务。路由器不包装 `ctx.llm.stream()`，自身也不发起任何提供方调用：打分是纯文本分析，因此重放的会话会得到完全相同的路由。

## 校准契约（v2）

**任何单一信号族都无法独自让一轮升级。** 每个信号族的分值上限都严格低于默认阈值 4，该契约由测试与发布守卫机器验证（`noFamilyAloneReaches`）：

| 信号族 | 每次命中的分值 | 族上限 |
|---|---:|---:|
| 显式深度推理请求（"think step by step"、"ultrathink"、一步步 等） | 3 | 3 |
| 形式化推理标记（prove、theorem、证明 等） | 1 | 3 |
| 系统设计标记（architecture、refactor、架构 等） | 1 | 3 |
| 围栏代码块 | 1 | 2 |
| 长度区间（800 字符） | 1 | 2 |

因此升级需要一次显式深度推理请求**加上**一个佐证信号，或多个独立信号族同时成立。具体来说："Fix the race condition in the scheduler." 得 0 分（留在快速层级）；"Prove the theorem." 得 2 分；单独的 "Think step by step" 得 3 分；1600 字符的无意义填充得 2 分；"Prove the theorem. Think step by step." 得 5 分（升级）。英文标记按词边界正则匹配；简体中文标记与部署方通过 `extraMarkers` 配置的标记按普通子串匹配（CJK 没有词边界），因此词表扩展无需引入正则。

打分只读取本轮的请求文本：直接人类消息（`source.kind === 'user'`）与父协调方委派（`source.kind === 'coordinator'`）计入——它们是发出工作请求的两种来源——而插件注入的上下文（时间快照、文件通知）、子代理报告与工具结果从不影响初始分数。

## 权威（v4）：单一持久 ModelSelectionState

选择状态是**一个**持久对象，而不是 WeakMap、被选模型与请求 header 的联邦。`model/selection-authority` 记录完整的 `ModelSelectionState`：`manual` 模式（权威 `user`/`sdk`/`policy`/`subagent-owner`，外加**完整选择**——provider、model、推理强度）或 `auto` 模式（权威 `router`/`default`，无选择）。Web 选择器与 JSON-RPC SDK 的 `initialize` 参数通过 `@deepseek-ai/dsh-agent` 中的 `claimModelSelection`/`markExplicitModelSelection` 声明 manual 状态，**无条件写入**（权威是运行时状态，不是可观测性）。**被手动选择的会话完全不归路由器管理**：手动选择的 Flash 永不被升级，手动选择的 Pro 永不被降级，且选择本身——不只是权威——是崩溃持久的（即使请求 header 仍指向旧模型，重启也会恢复被声明的模型）。

权威事件刻意**独立于任何路由器策略版本**——它携带自己的 `authoritySchemaVersion`，从不携带路由器策略版本——因此未来的路由器升级永远无法抹掉已记录的人类或 SDK 选择。每次声明都会写入会话级 `authorityEpoch`，且永不重置：`nextAuthorityEpoch` 在所有已持久化 epoch（包括 v0.15.2 遗留在路由决策上的承载）之上继续，因此任何重启、策略迁移或模式变更都不会复用 epoch。

**Auto 是一等状态，且通过生产 API 暴露。** `session.selectModel` 接受判别式 `{ mode: 'auto' }` 载荷：释放 manual 权威（从**持久日志**推导当前状态，因此真实进程重启后 Auto 依然有效——绝不依赖 WeakMap），并通过非声明式重置把生效选择恢复为部署默认值，因此陈旧的被选路由——包括外部的手动模型——无法继续冒充手动选择。该释放同样在重启后保持。

每一次**语义变更**都会记录——同权威的 Pro→Flash 切换是一次转换而非空操作（只有完整状态一致才被抑制），因此崩溃绝不会在今日权威下恢复昨日的模型。进程重启后，`reconstructRoutingState` 读取最新一条起决定作用的记录：manual 状态（或遗留显式屏障——任何策略版本下都被尊重）意味着路由器让位；auto 状态或最新的当前策略路由器决策则恢复路由器管理并保留路由连续性。重建是穷尽的——`default` 是真实状态而非僵尸——且保守：来自**未来**模式版本的权威事件会**闭合失败**（路由器让位），而不是在降级后复活被取代的历史。没有 manual 权威时，重型提议只有在路由器能够*证明连续性*（逐字段 `callConfigEquals` 匹配，或它自己的持久决策历史）时才算路由器所有——仅凭模型相同永远不构成证明。

## 发现式复杂度：轮内单向升级

难度往往是执行中发现的，而非措辞里声明的。从第 2 步起，处于快速层级的轮次在任务本身变重时**一次性**升级到重型：轮内工具调用达到 8 次或累计工具结果字符达到 24000（均可配置；`discoveredEscalation: false` 关闭）。升级是单向的——重型路由绝不在轮内被降级——因此推理连续性、提供方缓存行为与工具循环一致性得以保留，同时轮次仍能适应开局措辞无法体现的证据。轮内升级的持久记录携带实测事实（`toolCalls`、`toolResultChars`）与触发边界（`tool-calls`、`tool-result-volume` 或 `composite`），因此自适应阈值可以从真实会话中实证调优。

## 持久路由决策

两条持久事件流，干净分离：**`model/selection-authority`**（谁拥有选择——由每个主动选择面无条件写入，携带 `authority`、`source`（`web`/`sdk`/…）、`authorityEpoch` 与 `authoritySchemaVersion`）与 **`model/routing-decision`**（路由器决定了什么——轮次、步骤、用于结果/成本关联的 `routingDecisionId`、被提议与被选择的路由、决策权威、生效中的会话 `activeAuthority`、原因、含各信号计数的分数、轮内升级的实测事实、阈值与路由器策略版本）。`recordAllDecisions: true` 记录**每一个**路由决策——包括子代理放行、外部路由放行与安静的保持步骤——因此遥测语料是完整的；权威事件在任何遥测模式下都持久。终结先前路由器所有权的放行（外部模型接管、子代理所有者接管）即使在精简模式下也会记录该转换。

**校准契约在配置加载时强制执行**：会让单一信号族独自升级的 `escalationThreshold`（对默认族上限而言即 1–3）会被拒绝；配置的 `extraMarkers` 词表会检查伪独立性——跨族重复、族内经规范化（trim + 小写 + NFC）后重复、或与内建词表相撞（无论同族还是异族）的标记都会在加载时失败，并指出涉案标记与两个族。

其余由测试覆盖的策略保证：外部路由原样放行（操作者指定的未列出模型具有权威性）；子代理会话默认放行（`routeSubagents: true` 纳入后，协调方撰写的子代理请求参与打分）；一轮的路由在其第一步固定；每个层级可携带自己的 `reasoningEffort`（切换层级丢弃前一模型的推理强度，让新模型的适配器默认值生效），而采样标量（`temperature`、`maxTokens`、`stop`）保留；轮内事实按需读取——放行与保持路径从不扫描请求文本。

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY

- name: '@deepseek-ai/dsh-llm-model-router'
  config:
    fastRoute:
      provider: deepseek-official
      model: deepseek-v4-flash
    heavyRoute:
      provider: deepseek-official
      model: deepseek-v4-pro
      reasoningEffort: max
    escalationThreshold: 4
    extraMarkers:
      math: [bewijs, stelling]   # deployment vocabulary, matched as substrings
    discoveredEscalation:
      minToolCalls: 8
      minToolResultChars: 24000
```

两个层级必须是不同的提供方/模型组合，并像任何其他选择一样通过 `ctx.llm` 解析：agent loop 在分发前用 `prepareCall()` 校验返回的配置。单独发布的 `./invariant` 伴随包刻意为空——路由器的持久词表是 `model/routing-decision`，由本包拥有，并与 loop 的 `request/header` 机制并列记录。

## 离线路由分析

`analyzeTaskStructure()` 从路由前已知的提示文本和运行时计数生成独立的 `workload-v2` 模式。它测量约束、请求输出结构、转换距离、源/输出基数、任务类别独热分数和上下文事实，无需调用模型。`deriveBayesianHistoricalFeatures()` 使用调用方提供的先验平滑更早完成的结果；当前任务永远不会进入自身历史。

导出的训练和预测辅助函数保持离线且无权控制执行。它们不能覆盖显式选择、持久权限、上下文准入、提供商可用性或固定启发式路由器。在运行时生产者拥有预测时序和持久化之前，不存在影子会话事件。

## 模型体验

### 模型请求路由

#### 模型看到什么

两个层级之间只有请求 header 的 `provider`、`model` 和 `reasoningEffort` 发生变化。两条路由上的会话表面完全一致，任何路由元数据都不会进入模型可见内容。

#### Token 影响

快速层级的轮次按快速层级计费；被升级的轮次按重型层级计费。路由本身不消耗 token。校准契约正是为此存在：关键词堆砌或长度填充无法悄然把成本放大约 3 倍地推入重型层级。

#### KV 缓存影响

轮与轮之间切换层级会更换服务模型，提供方前缀缓存无法跨层级边界携带命中；连续处于同一层级的轮次保留其前缀。轮内升级需要为该轮剩余部分重建一次前缀——这是适应发现式复杂度的既定一次性代价。

## 已知限制与后续工作

- **英文 + 简体中文词表**——其他语言可通过显式推理、代码块与长度信号以及部署方 `extraMarkers` 升级，但没有内建词表。
- **发现式升级触发是体量启发式**——工具调用次数与结果字符数是难度的代理量而非语义；针对验证结果的校准是本事件词表所支持的后续工作。
- **固定权威策略**——除 `escalationThreshold` 外，分值、上限与阈值均为包常量；导出的学习模型辅助函数支持离线和影子评估，但不控制插件路由。
- **可选组合**——路由器不属于默认 bundle；部署方需显式添加插件行。
- **尚未消费运行时状态与结果信号**——验证失败、修复轮次与推理上下文压力是审计建议的更强升级信号，留待实证优化版本。
