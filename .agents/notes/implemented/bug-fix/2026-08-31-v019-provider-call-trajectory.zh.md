# Agent Note: 提供者调用轨迹和精确混合模型核算

Status: implemented

[English](2026-08-31-v019-provider-call-trajectory.md) | 中文

## 问题

成本按尝试计算，使用起始模型的价格应用于该回合的所有使用量。当回合中升级改变模型时（Flash 开始，Pro 结束），整个回合的成本被归因于 Flash 的价格，低估了 Pro 成本并高估了 Flash 成本。探索性运行被映射到 B0 实验身份，将安全门绕过的运行与基础设施验证混淆。

## 决策

**ProviderCallTrajectory：** 添加了 `ProviderCallTrajectory` 接口，包含 `requestId`、`turn`、`step`、`providerAttempt`、`model`、`provider`、`routingDecisionId`、`outcome`、`usage`、`costUsd` 和 `latencyMs`。每个 `model/usage` 事件成为一个提供者调用。每个调用的模型由该特定 (turn, step) 的路由决策决定，而非整个回合的第一个路由决策。

**每调用成本：** 每个提供者调用的成本使用该步骤的实际模型计算，在事件时间戳时查找定价注册表。尝试的 `costUsd` 是每调用成本之和。尝试的 `costByModel` 是累积每模型成本的 `Map<string, number>`。

**任务级成本分解：** `TaskTrajectory` 现在包含 `flashCostUsd`、`proCostUsd` 和 `costByModel: ReadonlyMap<string, number>`。这些从每尝试的 `costByModel` 映射计算，而非从起始模型的价格计算。

**AttemptTrajectory 扩展：** 添加了 `finalModel`（最后一个提供者调用的模型）、`modelsUsed`（尝试中的所有模型）、`costByModel` 和 `providerCalls`。

**探索性身份：** 添加了 `EXPLORATORY_EXPERIMENT_ID = 'v019-exploratory-v4'`。实验 ID 现在由 `runClass` 决定：基准运行使用 `EXPERIMENT_ID`，探索性运行使用 `EXPLORATORY_EXPERIMENT_ID`，B0 运行使用 `B0_EXPERIMENT_ID`。探索性运行不再映射到 B0。

**回合中 Pro 指标：** 在 `MetricsReport` 中添加了 `midTurnProRate`。计算任何尝试的 `modelsUsed.length > 1` 且包含 `deepseek-v4-pro` 的任务。

**`.tmp` 排除：** holdout 验证中的 rsync 命令现在排除 `.tmp` 以防止快照污染。

**指标更新：** 指标中的 `flashCost` 和 `proCost` 现在使用每模型成本分解中的 `t.flashCostUsd` 和 `t.proCostUsd`，而非起始模型归因的成本。

## 验证

全部 265 个评估、验证器快照、repair-runtime 和 repair-controller 测试通过。类型检查通过。

## 考虑过的替代方案

- **仅从 model/usage 事件的每步成本** — 采用：每个 usage 事件是一个提供者调用，按该步骤的实际模型计价。
- **保留起始模型归因** — 否决：在回合中升级时低估 Pro 成本并高估 Flash 成本，使经济指标无法辩护。
