# Agent Note: Replay exploratory trajectories with corrected accounting

Status: implemented
Archived: 2026-09-01

English | [中文](2026-08-31-v019-replay-exploratory-trajectories.zh.md)

## Problem

The v3 exploratory run used the B0/infra experiment identity (`v019-infra-validation-v3`) instead of a distinct exploratory identity. The trajectories also lacked the new per-model cost breakdown fields (`flashCostUsd`, `proCostUsd`, `costByModel`) and per-call trajectory data (`providerCalls`, `modelsUsed`, `finalModel`).

## Decision

Added `scripts/v019-replay-exploratory-trajectories.ts` to upgrade old v3 trajectories to the new schema:

- Re-derives `flashCostUsd` and `proCostUsd` from attempt-level model attribution.
- Builds `costByModel` maps from per-attempt costs.
- Synthesizes `ProviderCallTrajectory` entries from each attempt's usage and cost.
- Sets `finalModel` and `modelsUsed` from the attempt's starting model.
- Fixes the experiment identity from `v019-infra-validation-v3` to `v019-exploratory-v4`.
- Sets `runClass: 'exploratory'` and `securityGateBypassed: true`.
- Regenerates metrics with the corrected accounting.

## Limitation

The old trajectories only have attempt-level model data, not per-call granularity. Mid-turn escalations cannot be detected from the old data, so `midTurnProRate` is 0 in the replay. This is expected — the `ProviderCallTrajectory` infrastructure did not exist when the v3 run was collected.

## Verification

- 25/25 trajectories upgraded.
- 19/25 verified (matches the original v3 result).
- Experiment ID corrected to `v019-exploratory-v4`.
- Output written to `artifacts/evals/v019-exploratory-replay-v1/`.
