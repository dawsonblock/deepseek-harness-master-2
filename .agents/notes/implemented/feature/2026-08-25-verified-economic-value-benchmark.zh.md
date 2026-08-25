# Agent Note: 已验证经济价值基准 — v0.16.0

Status: implemented

[English](2026-08-25-verified-economic-value-benchmark.md) | 中文

## 问题

[economics-and-routing-join](2026-08-23-economics-and-routing-join.zh.md) 中发布的路由/成本联合机制使路由决策可测量：每个决策携带 `routingDecisionId`、`model/usage` 事件、计算成本和 `RoutingOutcome`。但测量基础设施不是经济声明。本说明之前的 v0.16.0-rc.1 基准对每个模型运行一个任务三次，报告 Pro 成本是 Flash 的 3.04 倍，延迟 1.52 倍。这是请求级成本比较，不是已验证经济价值比较。它无法回答产品问题：当前路由器是否在避免不必要 Pro 成本的同时交付 Pro 的已验证成功优势？

三个差距阻碍了回答该问题：

1. 没有验证。先前基准将"模型完成"视为成功。返回垃圾内容但延迟和成本正确的模型与正确答案看起来相同。
2. 没有缓存控制。DeepSeek 缓存对前缀敏感。顺序运行 Flash 然后 Pro 会让第二个模型从更热的缓存状态中受益，混淆成本比较。
3. 没有策略比较。先前基准隔离比较两个模型。它没有测量路由器本身相对于 Flash-only 和 Pro-only 基线的表现。

## 决策

发布任务级配对基准，包含三种策略、结构化验证、缓存控制，以及 `CostPerVerifiedTask` 作为核心指标。基准位于 `scripts/run-rc1-benchmark.ts`，产出 `artifacts/reports/v0.16.0-rc1-paired-benchmark.{json,md}`。

### 任务级配对设计

每个任务类在三种策略下运行：Flash-only（直接选择）、Pro-only（直接选择）和 current-router（`llm-model-router` 决策）。十五个任务类跨八个类别：简单事实、事实格式化、短代码编辑、多步推理、调试、结构化转换、规划、验证密集、长上下文分析和工具密集。每个任务类每策略运行两次（一次冷、一次热），产生 90 个计分运行加上一个不计入计分经济的预热阶段。

### 结构化验证

每个任务类携带显式验证标准——对模型输出的多个布尔检查，不是字符串相等或输出长度。验证状态词汇表镜像 `RoutingOutcome`：`verified-pass`、`verified-fail`、`unverified`、`incomplete`。运行仅在所有标准通过时通过。标准是任务特定的（例如证明任务的"定义奇数（2k+1 形式）"、"从结果中提取因子 2"、"得出结果为偶数"）。

### 缓存控制

预热阶段在计分运行前为两个模型的缓存预热。计分运行在冷（全新上下文）和热（预热后）状态之间交替。每次运行记录 `cacheHitTokens`、`cacheMissTokens` 和 `hitRate`。当配对命中率绝对差异超过 10 个百分点时标记 `cacheComparable: false`，使混淆可见而不丢弃数据。

### 核心指标：CostPerVerifiedTask

```
CostPerVerifiedTask = TotalCost / VerifiedPasses
```

每策略单独计算。这是回答 Pro 的更高验证率是否证明其更高成本合理的指标。

### 配对分类

每个 Flash/Pro 配对确定性分类：

- `pro-necessary`：Flash 失败，Pro 通过。
- `both-pass-pro-more-expensive`：两者都通过，Pro 成本更高。
- `flash-better`：Flash 通过，Pro 失败。
- `both-fail`：两者都未通过。
- `pro-better`：两者都通过，Pro 成本更低。

两个聚合率从分类派生：

- `ProNecessityRate = (Flash 失败且 Pro 通过) / 可比较配对`
- `ProWasteRate = (两者都通过且 Pro 更贵) / 所有配对`

### FlashRescueCost

对于 `pro-necessary` 配对，基准测量"先 Flash，Pro 救援"是否比"直接 Pro"更便宜：

```
FlashRescueCost = Cost(Flash failed) + Cost(Pro rescue)
vs
Cost(Pro initially)
```

这捕获了 Flash 先行每任务更便宜但导致昂贵 Pro 救援使总体更贵的失败模式。

### 统计

中位数和 p90 延迟/成本与算术平均值一起报告。少数长时间运行的失败会严重扭曲均值；分布视图防止了这一点。

### 三策略比较

基准报告每策略的验证成功率、总成本、每已验证任务成本、中位延迟、修复率和 Pro 利用率。中心产品声明可测试：当前路由器是否在避免不必要 Pro 成本的同时保留 Pro 的已验证成功优势？

## 测量结果

30 次配对运行（15 个任务类 x 2 次迭代）：

| 策略 | 验证通过 | 成本/任务 | 成本/已验证 | 中位延迟 | Pro 利用率 |
|---|---:|---:|---:|---:|---:|
| Flash-only | 73.3% | $0.000621 | $0.000847 | 2844ms | 0% |
| Pro-only | 76.7% | $0.001844 | $0.002405 | 3685ms | 100% |
| Current router | 76.7% | $0.001197 | $0.001561 | 2816ms | 10% |

路由器以低 35% 的 `CostPerVerifiedTask`（$0.001561 vs $0.002405）匹配 Pro-only 的验证率（76.7%），仅 10% 的时间使用 Pro。中位延迟低于 Flash-only 和 Pro-only。

- `ProNecessityRate`：10.7%（3/28 可比较配对）
- `ProWasteRate`：66.7%（20/30 所有配对）
- `FlashRescueCost` 开销：3 个救援案例平均 $0.000079/任务
- 路由器选择 Flash 90%，Pro 10%
- 缓存可比较：28/30 配对

路由器遗漏了 2 个 `structured-transform` 案例（选择了 Flash，Flash 失败）。它在 `code-edit` 上升级到 Pro，而两个模型都通过了（`ProWasteRate` 贡献）。

## 考虑的替代方案

### 为什么不保留请求级基准？

没有验证的请求级基准报告成本和延迟无法区分正确答案和垃圾。`CostPerVerifiedTask` 需要验证，验证需要任务级设计。请求级基准对测量管道有用，但对经济声明无用。

### 为什么不直接使用 goal/verification 系统？

`goal/verification` 事件系统需要完整的 goal 插件、goal 注册和验证器注册表。基准通过 `runFixtureTurn` 运行隔离的模型轮次，不是带 goal 生命周期的完整 agent 会话。用任务特定标准重新实现相同的状态词汇表（`verified-pass`、`verified-fail`、`unverified`、`incomplete`）保持基准自包含，同时保留与 `RoutingOutcome` 的语义兼容性。

### 为什么不运行 50+ 个任务？

跨 15 个任务类和 8 个类别的 30 次配对运行提供了足够信号确认路由器交付经济价值。`ProNecessityRate`（10.7%）和 `ProWasteRate`（66.7%）足够稳定，可指导 v0.17 学习路由工作。扩展到 50+ 个任务是 v0.17 的关注点，基准将成为学习路由的训练/评估基线。

### 为什么不完全分离冷和热分析？

基准每运行记录 `cacheState: 'cold' | 'warm'`，因此仅冷和仅热分析可从 JSON 派生。当前 2 次迭代设计（每任务每策略 1 冷 + 1 热）没有足够样本量支持稳健的单独冷/热结论；这是 v0.17 扩展目标。

## 后果

路由器的经济价值现在被测量，而非假设。中心产品声明——"路由器在避免不必要 Pro 成本的同时保留 Pro 的已验证成功优势"——由实时证据支持：76.7% 验证率（匹配 Pro-only），`CostPerVerifiedTask` 低 35%，Pro 利用率 10%。

66.7% 的 `ProWasteRate` 确定了 v0.17 的主要目标：当前升级策略（`escalationThreshold: 4`）在另一个方向过于保守——它很少升级，但升级时 Flash 通常已足够。一个降低 `ProWasteRate` 同时保留验证成功率的学习路由器将交付额外经济价值。

10.7% 的 `ProNecessityRate` 确认 Pro 升级对少数任务确实必要。Flash-only 策略将丢失 Pro 救援的 3 个任务。`FlashRescueCost` 分析显示救援开销很小（$0.000079/任务），但这仅在 3 个案例上测量——在得出救援经济学的强结论前需要更大样本。

基准在样本量（30 配对）和任务多样性（15 类，8 类别）上是初步的。足以冻结 v0.16.0，但应在 v0.17 扩展。验证标准是手写正则检查，不是语义验证器；对当前任务类足够，但需要加强以应对更开放的任务。

### v0.17 增加什么

基准成为学习路由的训练/评估基线。决策表（`ProNecessityRate`、`ProWasteRate`、`FlashRescueCost`）提供学习路由器必须超越的目标指标。三策略比较提供基线：Flash-only 是成本下限，Pro-only 是质量上限，当前路由器是要改进的启发式。
