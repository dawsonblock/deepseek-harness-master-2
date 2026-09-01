# Agent Note: Provider call trajectory and exact mixed-model accounting

Status: implemented

English | [中文](2026-08-31-v019-provider-call-trajectory.zh.md)

## Problem

Cost was computed per attempt using the starting model's pricing applied to all usage in the turn. When a mid-turn escalation changed the model (Flash starts, Pro finishes), the entire turn's cost was attributed to Flash at Flash pricing, understating Pro cost and overstating Flash cost. Exploratory runs were mapped to the B0 experiment identity, conflating security-gate-bypassed runs with infrastructure validation.

## Decision

**ProviderCallTrajectory:** Added `ProviderCallTrajectory` interface with `requestId`, `turn`, `step`, `providerAttempt`, `model`, `provider`, `routingDecisionId`, `outcome`, `usage`, `costUsd`, and `latencyMs`. Each `model/usage` event becomes one provider call. The model for each call is determined by the routing decision for that specific (turn, step), not by the first routing decision for the entire turn.

**Per-call cost:** Each provider call's cost is computed using the actual model for that step, looked up in the pricing registry at the event's timestamp. The attempt's `costUsd` is the sum of per-call costs. The attempt's `costByModel` is a `Map<string, number>` accumulating per-model cost.

**Task-level cost breakdown:** `TaskTrajectory` now includes `flashCostUsd`, `proCostUsd`, and `costByModel: ReadonlyMap<string, number>`. These are computed from the per-attempt `costByModel` maps, not from the starting model's pricing.

**AttemptTrajectory extensions:** Added `finalModel` (last provider call's model), `modelsUsed` (all models in the attempt), `costByModel`, and `providerCalls`.

**Exploratory identity:** Added `EXPLORATORY_EXPERIMENT_ID = 'v019-exploratory-v4'`. The experiment ID is now determined by `runClass`: benchmark runs get `EXPERIMENT_ID`, exploratory runs get `EXPLORATORY_EXPERIMENT_ID`, B0 runs get `B0_EXPERIMENT_ID`. Exploratory runs are no longer mapped to B0.

**Mid-turn Pro metric:** Added `midTurnProRate` to `MetricsReport`. Counts tasks where any attempt has `modelsUsed.length > 1` and includes `deepseek-v4-pro`.

**`.tmp` exclusion:** The rsync command in holdout verification now excludes `.tmp` to prevent snapshot contamination.

**Metrics update:** `flashCost` and `proCost` in metrics now use `t.flashCostUsd` and `t.proCostUsd` from the per-model cost breakdown, not the starting-model-attributed cost.

## Verification

All 265 evaluation, verifier-snapshot, repair-runtime, and repair-controller tests pass. Typecheck passes.

## Alternatives considered

- **Per-step cost from model/usage events only** — used: each usage event is one provider call, costed at the actual model for that step.
- **Keep starting-model attribution** — rejected: understates Pro cost and overstates Flash cost on mid-turn escalations, making economic metrics indefensible.
