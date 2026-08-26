# Agent Note: v0.18 RepairController — 纯修复决策服务

Status: implemented

[English](2026-08-26-v018-repair-controller-service.md) | 中文

## 问题

v0.17.4 实验证明，Flash + 客观验证 + 迭代修复 + 有界 Pro 升级是比单次 Pro 尝试更好的策略。但该结果存在于 `scripts/` 中——一个独立的实验运行器，没有持久状态、没有会话事件溯源、没有运行时集成。验证-修复循环尚未成为 DeepSeek Harness 的能力。

运行时需要一个纯决策服务，将"下一步做什么"（策略）与"执行决策"（代理循环）、"验证结果"（验证器）、"记录发生了什么"（会话账本）分离。没有这种分离，修复逻辑会坍缩到代理循环中，无法确定性测试或崩溃后重建。

## 决策

v0.18 引入 `@deepseek-ai/dsh-repair-controller`——一个纯 Cordis 服务，在验证结果后决定下一步操作。该服务不持有状态、不调用模型、不修改文件、不写入事件。代理循环编排控制器；控制器不编排循环。

### 接口

```ts
interface RepairController {
  decide(input: RepairDecisionInput): RepairDecision;
}
```

`RepairDecisionInput` 携带尝试历史、最新失败包、成本/时间预算和运行时拥有的限制。`RepairDecision` 是判别联合类型：`complete`、`flash-repair`、`pro-escalate` 或 `stop`。

### 首个运行时策略（v0.18 验证升级）

```text
Flash #1 → 验证
  通过 → 完成
  失败 → Flash #2（带证据）
Flash #2 → 验证
  通过 → 完成
  失败 + 相同/无进展 → Pro
  失败 + 有进展 → Flash #3
Flash #3 → 验证
  通过 → 完成
  失败 → Pro
Pro #1 → 验证
  通过 → 完成
  失败 → Pro #2
Pro #2 → 验证
  失败 → 停止（Pro 耗尽）
```

硬限制由运行时拥有：最多 3 次 Flash、2 次 Pro、共 5 次。任何模型都不能增加自己的尝试限制。

### 持久事件

通过声明合并新增四个 `SessionEventMap` 成员：

- `repair/evidence` — 一次尝试的失败证据。
- `repair/decision` — 一次控制器决策。
- `model/escalation` — 显式 Flash→Pro 升级，带修复溯源。
- `repair/completed` — 任务级核算（尝试次数、成本、延迟）。

`model/escalation` 事件为 `RoutingOutcome` 提供显式修复溯源，而非推断。

### 与提供商重试分离

提供商重试（503、超时、连接失败）是同一逻辑尝试的概念。任务修复（模型完成但验证失败）是新逻辑尝试的概念。修复循环不替换或扩展提供商重试逻辑。

### 可选启用

修复通过 cordis.yml 配置可选启用。v0.18 不会静默更改每个现有 Harness 工作流。

## 实现

- 包：`packages/core/repair-controller/`
- 类型：`src/types.ts`
- 纯决策：`src/decide.ts` — `decideRepair()`
- 服务：`src/index.ts` — `RepairControllerService`
- 事件：`src/events.ts` — 四个新事件类型的声明合并
- 测试：`tests/decide.spec.ts` — 16 个确定性测试

## 验证

- 16 个确定性测试通过。
- 类型检查通过。
- Lint 通过。
- 未消耗 API 令牌——所有测试均为无密钥确定性测试。

## 后果

- 代理循环需修改以在验证后调用 `RepairController.decide()` 并执行返回的操作。
- 崩溃/重放持久性测试需验证修复状态在进程终止后从会话日志确定性重建。
- 五个实时沙箱留出夹具仍是启用策略前的最终资格门。
