# Agent Note: 重放探索性轨迹并修正核算

Status: implemented

[English](2026-08-31-v019-replay-exploratory-trajectories.md) | 中文

## 问题

v3 探索性运行使用了 B0/基础设施实验身份（`v019-infra-validation-v3`），而非独立的探索性身份。轨迹也缺少新的每模型成本分解字段（`flashCostUsd`、`proCostUsd`、`costByModel`）和每调用轨迹数据（`providerCalls`、`modelsUsed`、`finalModel`）。

## 决策

添加了 `scripts/v019-replay-exploratory-trajectories.ts` 以将旧 v3 轨迹升级到新模式：

- 从尝试级模型归因重新推导 `flashCostUsd` 和 `proCostUsd`。
- 从每尝试成本构建 `costByModel` 映射。
- 从每次尝试的使用量和成本合成 `ProviderCallTrajectory` 条目。
- 从尝试的起始模型设置 `finalModel` 和 `modelsUsed`。
- 将实验身份从 `v019-infra-validation-v3` 修正为 `v019-exploratory-v4`。
- 设置 `runClass: 'exploratory'` 和 `securityGateBypassed: true`。
- 使用修正后的核算重新生成指标。

## 局限

旧轨迹仅有尝试级模型数据，没有每调用粒度。无法从旧数据检测回合中升级，因此重放中 `midTurnProRate` 为 0。这是预期的——v3 运行收集时 `ProviderCallTrajectory` 基础设施尚不存在。

## 验证

- 25/25 轨迹已升级。
- 19/25 验证通过（与原始 v3 结果一致）。
- 实验身份修正为 `v019-exploratory-v4`。
- 输出写入 `artifacts/evals/v019-exploratory-replay-v1/`。
