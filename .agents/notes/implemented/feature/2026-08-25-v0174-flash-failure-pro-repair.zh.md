# Agent Note：v0.17.4 真实 Flash 失败 → Pro 修复实验

Status: implemented

[English](2026-08-25-v0174-flash-failure-pro-repair.md) | 中文

## 问题

v0.17.3 证明验证触发的 Flash 到 Pro 升级以比 Pro-only 低 55.3% 的每验证任务成本达到相同的验证成功率范围。然而，v0.17.3 模拟使用反事实配对运行：Pro 结果是一个从未接收 Flash 失败证据的独立尝试。该结果估计升级经济学，但不估计证据条件修复的经济学。独立重试代理（98% 验证）被正确排除在修复声明之外，因为重复提示不是修复轨迹。

关键未回答的问题是 Pro 能否接管 Flash 已经失败的任务，以及给 Pro 失败证据是否有助于它在全新 Pro 启动无法成功的地方成功。

## 决策

v0.17.4 构建并验证真实修复实验基础设施。它定义规范 `FailurePackage`、确定性失败指纹、进度感知同失败升级、有界阶段循环，以及执行连接多阶段轨迹的运行器，其中 Pro 接收实际 Flash 失败证据并在修改工作区之前选择 `REPAIR_EXISTING` 或 `ROLLBACK_AND_REDO`。

**v0.17.4 是研究实验。它不改变运行时路由权限。确定性顺序保持不变：手动选择 → 持久权限 → 硬策略约束 → 上下文/提供者可用性 → 权威启发式路由器。**

实验在相同编码任务语料库上比较五个策略：

```text
A. flash-only: Flash → verify → done
B. pro-only: Pro → verify → done
C. flash-fail-pro-fresh: Flash → verify → fail → Pro fresh start (no evidence)
D. flash-fail-pro-repair: Flash → verify → fail → FailurePackage → Pro repair with evidence
E. flash-repair-then-pro: Flash → verify → fail → Flash repair with evidence → Pro takeover if still failing
```

策略 D 是主要结果。如果 D 优于 C，失败证据帮助 Pro 接管失败的 Flash 任务。

### FailurePackage

规范失败证据结构定义在 `scripts/v0174-repair-core.ts`：

```ts
interface FailurePackage {
  taskId: string
  routingDecisionId: string
  originalGoal: string
  attempt: {
    model: string
    changedFiles: readonly string[]
    patchSummary?: string
  }
  verification: {
    failedCriteria: readonly string[]
    failingTests: readonly string[]
    typeErrors: readonly string[]
    buildErrors: readonly string[]
  }
  failureFingerprint: string
  progress: 'none' | 'partial' | 'regression'
  checkpoints: {
    taskStart: string
    afterFlash: string
  }
}
```

该结构保留原始目标，标识 Flash 模型和路由决策，记录已更改文件和补丁摘要，捕获客观验证失败（失败标准、失败测试、类型错误、构建错误），携带确定性指纹，相对于先前失败分类进度，并记录任务开始和 Flash 后检查点。

### 确定性失败指纹

`computeFailureFingerprint()` 通过剥离绝对文件路径、行:列位置、时序、十六进制地址和附带格式来规范化失败证据，然后用 SHA-256 哈希排序后的规范化内容，截断为 16 个十六进制字符。因相同实质原因失败的两次尝试产生相同指纹，无论附带差异如何。

### 进度感知同失败升级

`classifyProgress()` 比较当前失败证据与先前失败证据，返回 `none`（首次失败或相同实质失败）、`partial`（更少或不同失败）或 `regression`（更多失败）。

`decideEscalation()` 应用升级规则：两次连续 Flash 失败共享相同指纹后，立即升级到 Pro 而非浪费另一次 Flash 调用。这实现进度感知升级而非任意重试计数。

### 有界阶段循环

`LoopBounds` 限制每任务总阶段数（默认 4：Flash、Flash 修复、Pro、停止）。`detectLoopViolation()` 验证没有轨迹超过边界。运行器在每个任务后检查违规。

### Pro 接管决策

Pro 通过 `constructProRepairPrompt()` 接收 `FailurePackage`，必须在进行任何更改之前在第一行声明 `REPAIR_EXISTING` 或 `ROLLBACK_AND_REDO`。`parseTakeoverDecision()` 提取选择。对于 `REPAIR_EXISTING`，Pro 在与 Flash 相同的工作区中工作。对于 `ROLLBACK_AND_REDO`，Pro 从干净工作区开始。

### 客观验证

编码任务固件使用基于文件的任务和客观验证：TypeScript 类型检查（`tsc --noEmit`）和测试执行（`vitest run`）。每个固件创建初始文件（package.json、tsconfig.json、测试文件），代理编写实现文件。验证在每个阶段后运行，并收集失败测试、类型错误和构建错误作为结构化证据。

### 指标

实验报告：

- **验证成功率** — 主要约束。
- **每验证任务成本** — 主要优化目标。
- **Pro 救援率** = Flash 失败后由 Pro 验证的任务 / 升级到 Pro 的任务。
- **升级成本效率** = 总升级成本 / 成功 Pro 救援。
- **可审计升级率** = 有构建 FailurePackage 的升级 / 总升级。
- **同失败检测率** — 重复 Flash 失败共享相同指纹的任务。
- **循环违规** — 必须为 0。
- **REPAIR_EXISTING 与 ROLLBACK_AND_REDO 选择分布。**
- **中位数和 p90 延迟。**

### 无密钥验证

`scripts/v0174-repair-core.spec.ts` 验证 53 个测试用例，覆盖指纹确定性、顺序独立性、路径规范化、进度分类、同失败检测、升级决策、循环边界执行、FailurePackage 构建、Pro 修复提示生成、接管决策解析和策略指标计算。所有测试在无 API 密钥的情况下通过。

### 实时收集

运行器在无 `DEEPSEEK_API_KEY` 时自动跳过。实时收集需要轮换凭证；先前暴露的密钥已泄露，不得重用。运行器在每个任务后检查点并恢复而不重复已完成任务。

## 考虑的替代方案

### 继续使用反事实配对模拟

v0.17.3 的配对模拟估计升级经济学但无法衡量失败证据是否帮助 Pro。需要真实修复轨迹来隔离 FailurePackage 的价值。

### 添加新运行时修复包

专用的 Cordis 插件包用于修复语义会为没有当前运行时消费者的研究实验过度构建。核心类型和逻辑作为纯函数存在于 `scripts/v0174-repair-core.ts`。如果 v0.18 推广该策略，类型可以在那时提升为包。

### 用编码任务修复语义重载 llm-retry

`llm-retry` 处理提供者级 HTTP 失败和有界重试策略。编码任务修复是不同关注点：它操作工作区状态和验证证据，而非请求失败。重载 `llm-retry` 会混淆两个不同的失败域。

### 在 model/routing-decision 事件上写入显式 repairOf 元数据

`routing-outcome.ts` 中的 `RepairAttribution` 支持显式 `repairOf` 元数据，但没有生产者写入。添加生产者会为研究实验更改会话事件协议。实验在实验级别记录修复归属，保持运行时协议不变。真实生产者推迟到 v0.18 推广。

### 使用文本输出任务而非基于文件的编码任务

v0.17.2 语料库使用通过正则验证的文本输出任务。修复架构（REPAIR_EXISTING、ROLLBACK_AND_REDO、Flash 差异、已更改文件）需要具有客观验证（类型检查、测试）的基于文件的任务。新编码任务固件专为修复实验设计。

## 后果

仓库现在有经过验证的真实证据条件修复实验基础设施。规范 `FailurePackage`、确定性指纹、进度感知升级和有界循环是具有无密钥测试覆盖的纯函数。运行器准备好使用轮换凭证进行实时收集。

实验结果将决定 v0.18 是否将验证触发升级推广为权威运行时行为。推广门槛要求：Flash→Pro 修复在 Pro-only 验证成功率约 1-2 个百分点范围内或更好，每验证任务成本至少低约 40%，Pro 利用率低于约 20-25%，高救援效率，同失败检测防止无用重试，无无限循环，每次升级有可审计失败证据，每个最终结果接受独立验证。

学习型路由研究保持降级为离线仪表。workload-v2 特征和贝叶斯历史最终可能为少数可预测浪费先尝试 Flash 的任务提供 Pro 优先覆盖，但该预测器对于响应式升级策略不是必需的。
