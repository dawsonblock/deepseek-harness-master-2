# Agent Note: 轮中路由升级膨胀了 Pro repair 计数器

Status: implemented

[English](2026-08-31-v019-midturn-escalation-attribution.md) | 中文

## 问题

repair runtime 在验证通过时，将 attempt 归因于该 turn 最新 `model/routing-decision` 事件的模型。当路由器执行轮中升级（从 Flash 到 Pro，即发现复杂性功能）时，该 turn 最新的路由决策是 Pro，因此 `handleVerificationPass` 递增了 `state.proAttempts`，即使 attempt 以 Flash 开始且 Flash 完成了大部分工作。这使得 `repair/completed` 事件中的 `proAttempts` 在 22 任务的探索性运行中从 6 膨胀到 16，导致 `ProEscalationRate` 读数为 72.7% 而非正确的 27.3%。

轨迹收集器另外从该 turn 的第一个 `model/routing-decision` 提取 attempt 模型（使用 `find`），因此 `attempts` 数组正确显示 Flash。`proAttempts=1` 与 `attempts[0].model=flash` 之间的矛盾使聚合指标内部不一致：14 个一次性 Flash + 16 个 Pro 升级 + 1.27 平均 attempts/task 无法同时成立。

一个次要的字段名 bug 加剧了问题：轨迹收集器读取路由决策事件的 `selection?.model`，但事件 schema 使用 `selected.model`。对 `model/usage` 模型字段的回退掩盖了 attempts 数组中的此 bug，但未掩盖 repair 计数器。

## 决策

repair runtime 现在使用 `firstRoutingDecisionId`（该 turn 的第一个路由决策）而非 `latestRoutingDecisionId` 来将验证通过归因于模型。轮中路由升级是路由功能，不是 repair 升级；attempt 的模型归因反映哪个模型开始了 attempt，而非哪个模型完成了它。

轨迹收集器现在从 `attempts` 数组派生 `flashAttempts` 和 `proAttempts`，而非信任 `repair/completed` 事件的计数器。这使得轨迹自洽，不受 repair runtime 内部会计影响。字段名 bug（`selection` vs `selected`）也已修复。

## 验证

22 个已评估 Batch A 轨迹现在一致：22 Flash + 6 Pro = 28 总 attempts，匹配 1.27 平均 attempts/task。`ProEscalationRate` 从 72.7% 修正为 27.3%，`ProRescueRate` 从 68.8% 修正为 33.3%。repair-runtime 包测试（149）和评估测试（31）通过。

## 考虑过的替代方案

- **将轮中升级计为 Pro attempt** — 否决：轮中路由升级是路由器在单次 attempt 内适应发现的复杂性，不是 repair 决策。将其计为 Pro 会混淆路由策略与 repair 策略。
- **仅从 `repair/decision` 事件派生计数器，不从验证通过派生** — 否决：一次性成功没有 `repair/decision` 事件，因此计数器对每个一次性任务读数为零，丢失 attempt 归因信号。

## 后果

轨迹中的 `flashAttempts` 和 `proAttempts` 现在反映每个 attempt 的起始模型，而非 repair runtime 的内部计数器。`repair/completed` 事件的计数器保留供 runtime 自身使用（repair controller 决策），但不再是轨迹指标的真相来源。以 Flash 开始并轮中升级到 Pro 的 turn 计为一次 Flash attempt，而非一次 Pro attempt。
