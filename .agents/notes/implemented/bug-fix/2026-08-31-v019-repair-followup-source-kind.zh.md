# Agent Note: 修复 repair followup 消息 source kind

Status: implemented

[English](2026-08-31-v019-repair-followup-source-kind.md) | 中文

## 问题

repair runtime 在发出 Flash-repair 和 Pro-escalation 后续消息时使用 `source: { kind: 'goal', goalId, revision, round: goal.roundsStarted + 1 }`。goal fold（`packages/goal/goal/src/fold.ts` 中的 `applyGoalEvent`）仅当 `source.round === state.roundsStarted + 1` 时才准入 `kind: 'goal'` 的 `user/message` 事件，并递增 `roundsStarted`。repair followup 不是 goal round——goal-round driver 才拥有 round 准入——因此第二次 repair followup 复用 `round: 1` 而 `roundsStarted` 已递增到 1，抛出 `goal round at session event N is not the next admitted round of the active goal`。这阻塞了 S8 组合资格场景（两次 Flash 失败 → Pro 升级）以及任何多于一次 followup 的真实 repair 序列。

## 决策

repair runtime 现在在 `packages/core/repair-runtime/src/index.ts` 中将后续消息的 source 改为 `{ kind: 'plugin', plugin: 'repair-runtime' }`。repair followup 是插件注入的上下文，不是 goal round；goal-round driver 仍是 `GoalMessageSource` 的唯一消费者。

## 验证

组合 runtime 资格 S8 场景通过（24/24 检查）。repair-runtime 包测试（149 项）和 P2.6 崩溃边界等价测试（22 项）通过。完整测试套件无新增失败。

## 考虑过的替代方案

- **按 repair followup 递增 `roundsStarted`** — 否决：repair 尝试不是 goal round，不应消耗 goal round 预算。goal-round driver 拥有 round 准入。
- ** disarm goal 以抑制 driver** — 否决：冲突在于 source kind，不在于 driver。disarm 会隐藏不变量违规而非修复它。

## 后果

repair followup 消息不再携带 `GoalMessageSource`。按 `kind: 'goal'` 过滤的回放和轨迹重建不会包含 repair followup，这是正确的——repair followup 是插件上下文，不是自主 goal round。
