# Agent Note: 经济与路由关联 — v0.16.0-alpha.2

Status: implemented

[English](2026-08-23-economics-and-routing-join.md) | 中文

## 问题

持久化模型选择控制面（v0.15.5）记录了选择哪个模型以及原因，但未记录该选择消耗了什么、花费了多少。令牌用量存在于 `assistant/message.usage` 上，这是一个转录事件——它只存在于成功的助手消息中。一次重试消耗了提供商令牌但在产生最终消息前失败，不会留下任何记账痕迹。没有定价注册表，没有成本计算，也无法将路由决策与其经济结果关联。

v0.16.0-alpha.1 记账核心建立了规范 `TokenUsage` 词汇表（缓存命中、缓存未命中、总量、来源、请求 ID、路由关联）和带不变量校验的 DeepSeek 提供商归一化器。alpha.2 在该词汇表之上构建经济层：路由决策身份传播、持久化逐次尝试记账事件、版本化定价、成本计算和按路由决策聚合。

## 决策

五个决策，各自详述如下：

1. **`routingDecisionId` 通过执行上下文以回溯日志扫描方式传播**，而非请求作用域元数据。`agent/request` 瀑布返回 `LlmCallConfig`，不返回元数据，因此步骤循环从会话日志中查找当前 turn/step 的最新 `model/routing-decision` 并将其标记到 `model/request` 和 `assistant/message` 用量上。
2. **`model/usage` 是规范记账事件流**，每次付费尝试发出一次，无论轮次是否成功。`assistant/message.usage` 保留为向后兼容的转录投影。所有定价、聚合和未来的结果关联都折叠 `model/usage`，绝不折叠 `assistant/message.usage`。
3. **定价是与令牌用量分离的版本化注册表。** `ModelPricing` 携带 `observedAt`（仓库固定价格的时间）和可选的 `effectiveFrom`（提供商说价格生效的时间）。DeepSeek 不发布生效日期，因此 V4 快照仅使用 `observedAt`。
4. **成本计算使用不相交约定：缓存命中 + 缓存未命中 + 输出。** 绝不从 `totalTokens` 计费（缓存命中和缓存未命中价格不同），也不单独添加 `reasoningTokens`（DeepSeek 将推理作为完成用量的一部分计费）。缺失缓存字段产生 `conservative-estimate` 置信度标签。
5. **聚合是对不可变记录的纯折叠。** 没有可变会话计数器。`usageBySession`、`usageByTurn`、`usageByModel`、`usageByRoutingDecision` 和 `routingDecisionAccounting` 从 `model/usage` 事件流派生视图。

### 路由决策关联

路由器钩入 `agent/request`，调用 `decideRoute`，追加带有确定性生成的 `routingDecisionId` 的 `model/routing-decision`，并返回选定的 `LlmCallConfig`。步骤循环的 `latestRoutingDecisionId` 辅助函数向后扫描会话日志，查找匹配当前 turn/step 的最新路由决策。

不变量：对于一个 (sessionId, turn, step)，正在构造的模型请求最多有一个有效路由决策。重试复用同一个路由决策——`routingDecisionId` 标识路由选择，`attempt` 标识提供商执行。

这是回溯查找而非真正的请求作用域来源。未来的重构可以用瀑布返回值上的请求作用域执行元数据替换日志扫描，但仅在路由器被允许在重试尝试之间重新路由时才需要（这要求路由决策身份中包含 `attempt`）。当前设计足够，因为今天的重试总是复用同一个路由决策。

### `model/usage` 事件

新的可忽略 `model/usage` 会话事件记录逐次尝试的提供商令牌记账：

```
turn, step, attempt, provider, model, usage: TokenUsage, routingDecisionId?
```

它在三条路径中发出：
- 成功：流完成后、`assistant/message` 之前。
- 错误/中止完成：完成被分类为错误或中止后、重试决策之前。
- 中断流：信号被中止时的 catch 块中、中断的 `assistant/message` 之前。

当适配器不报告用量时（例如流在最终用量块之前中止），它不会发出。这防止了伪造的提供商记录。

`assistant/message.usage` 保留用于向后兼容的 UI 投影，并通过 `usageSpread` 辅助函数标记 `routingDecisionId`。新记账代码仅折叠 `model/usage`。

### 定价注册表

`ModelPricing` 区分 `observedAt` 和 `effectiveFrom`：

```typescript
interface ModelPricing {
  provider: string
  model: string
  currency: 'USD'
  version: string
  observedAt: string
  effectiveFrom?: string
  perMillion: { cacheHitInput, cacheMissInput, output }
}
```

DeepSeek 当前页面列出了价格但未发布官方生效日期。仓库快照 `DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23` 记录 `observedAt: '2026-08-23'`，`effectiveFrom` 缺失。版本字符串 `deepseek-v4-usd-observed-2026-08-23` 编码的是观测日期，不是生效日期。

DeepSeek V4 定价（每百万令牌，美元）：

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---|---|---|
| deepseek-v4-flash | $0.0028 | $0.14 | $0.28 |
| deepseek-v4-pro | $0.003625 | $0.435 | $0.87 |

### 成本计算

`calculateCost(usage, pricing)` 产生带逐组件分解和置信度的 `CalculatedModelCost`：

```
C = (H/1M) * P_hit + (M/1M) * P_miss + (O/1M) * P_out
```

其中 H = `cacheReadTokens`，M = `cacheMissTokens ?? inputTokens`，O = `outputTokens`。

置信度仅在缓存分解存在且 `source === 'provider'` 时为 `'exact'`。缺失缓存字段的遗留用量、估算用量和缺失缓存分解的提供商用量都产生 `'conservative-estimate'`。

### 聚合

对不可变 `model/usage` 记录的纯折叠：

- `extractUsageRecords(events, sessionId)` — 将 `model/usage` 事件投影为 `ModelUsageRecord`。
- `usageBySession` — 所有记录在一个总计量对象中。
- `usageByTurn` — 按 turn 编号分组。
- `usageByModel` — 按 `provider/model` 分组。
- `usageByRoutingDecision` — 按 `routingDecisionId` 分组，排除手动选择。
- `routingDecisionAccounting` — 逐决策视图，包含模型列表、尝试次数和聚合总量。

`UsageTotals` 包含 `requests`、令牌总和（input、cacheRead、cacheMiss、output、reasoning、total）、`cacheHitRate`、`costUsd` 和 `exactCosts`/`estimatedCosts` 计数。

## 考虑过的替代方案

### 为什么不折叠 `assistant/message.usage` 做记账？

一次重试消耗了提供商令牌但在产生最终助手消息前失败，不会留下 `assistant/message` 事件。折叠 `assistant/message.usage` 会丢失付费尝试。不变量测试证明：2 个 `model/usage` 事件，1 个 `assistant/message`，记账总量 = 尝试1 + 尝试2。

### 为什么不把定价放在模型注册表中？

模型能力和价格生命周期是不同的事情。DeepSeek 明确警告价格可能变化。模型注册表描述模型能做什么；定价注册表描述在特定观测快照下它花费多少。耦合它们会迫使每次价格变化都更新模型注册表。

### 为什么不通过瀑布返回值传递 `routingDecisionId`？

`agent/request` 瀑布契约返回 `LlmCallConfig`。将该契约改为返回 `{ config, executionMetadata }` 将是触及每个瀑布监听器的侵入式重构。在当前不变量（重试复用同一路由决策）下，回溯日志扫描足够。`latestRoutingDecisionId` 上的架构注释记录了限制和需要重构的条件。

### 为什么不使用 `effectiveFrom` 作为定价快照？

DeepSeek 当前页面给出价格但未建立官方生效日期。记录 `effectiveFrom: '2026-08-23'` 会暗示提供商发布了该日期，这是不可辩护的。`observedAt` 记录仓库固定价格的时间；`effectiveFrom` 保留给提供商明确发布的情况。

## 后果

路由/成本关联现在可靠。对于每个路由决策，测试框架可以确定运行了什么模型、消耗了什么、花费了多少以及在哪个定价版本下。`confidence` 标签防止历史记录伪装为提供商精确经济数据。

`model/usage` 事件可忽略，通过 JSONL 和 SQLite 持久化。快照刷新更新了黄金文件以包含 `model/usage` 事件；回放仅存在已知的 `durationMs` 计时方差失败（记录在 v0.15.5 基线报告中）。

`TOKEN_USAGE_INCONSISTENT` 的 `console.warn` 诊断（alpha.1）仍作为低影响范围的 alpha 解决方案保留。它应在 RC1 期间迁移到仓库的结构化诊断/遥测系统，携带 provider、model、requestId、invariant 和原始值，不污染 stderr 或快照。

token-meter 套件完全通过（55/55）。已知的 `reasoningTokens: 0` 断言不匹配通过更新过时的测试期望解决：`undefined` 表示提供商未报告推理用量；`0` 表示提供商明确报告了零。源代码正确地为非推理消息发出 `reasoningTokens: 0`。

### RC1 添加什么

下一个里程碑不是令牌计数本身，而是每美元验证结果：

```
model/usage → routingDecisionId → CalculatedModelCost → outcome-verification receipt → RoutingOutcome
```

该记录——路由决策、模型、令牌、成本、修复、验证结果——是使路由器可实验测量而非启发式的东西。
