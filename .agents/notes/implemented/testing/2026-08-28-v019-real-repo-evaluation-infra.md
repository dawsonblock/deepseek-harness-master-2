# Agent Note: v0.19 real-repository evaluation infrastructure

Status: implemented

## Problem

v0.18.0 qualified the durable verified self-repair control plane with 318 tests, 13/13 control-plane invariants at zero, and 3/5 unseen holdout passes. The architecture is ahead of the model benchmark. The unanswered question is whether the system remains useful on large, messy, unfamiliar repositories — a class of problems synthetic fixtures cannot expose.

## Decision

Build the v0.19 real-repository evaluation infrastructure as scripts that wrap the frozen v0.18.0 repair controller policy for real-repository tasks. The infrastructure records full trajectory data, computes pre-registered metrics, and classifies failures into a taxonomy that will determine v0.19 architecture changes.

The v0.18.0 repair controller policy is the experimental control: `maxFlashAttempts=3`, `maxProAttempts=2`, `maxTotalAttempts=5`, same/no progress → Pro, partial progress → another Flash attempt, Flash exhausted → Pro, Pro exhausted → stop. No threshold tuning, limit changes, or policy modifications during the first cohort.

Experiment identity `v019-real-repo-baseline-v1` records all version stamps, model routes, repair limits, and task corpus identity so every trajectory points back to a single experiment identity.

Pre-registered metrics: VerifiedTaskRate, OneShotFlashRate, RepairRescueRate, FlashSelfRepairRate, ProEscalationRate, ProRescueRate, MeanAttemptsPerTask, MeanCostPerTask, MedianCostPerTask, MeanCostPerVerifiedTask, MedianCostPerVerifiedTask, LatencyP50/P75/P90/P95/Max, SameFailureEscalationRate, RollbackRate, BudgetStopRate, ReplayMismatchRate, ProviderFailureRate.

Failure taxonomy F1-F18 distinguishes model reasoning failures, repository-context failures, verifier issues, escalation quality, budget exhaustion, and holdout edge cases.

Every attempt records: taskId, attempt number, model, routingDecisionId, usage tokens, cost, latency, diagnostic result, holdout result, failure fingerprint, progress, repair action, repair reason, changed files, and terminal outcome.

## Files

- `scripts/v019-experiment-identity.ts` — experiment manifest with frozen v0.18.0 policy
- `scripts/v019-task-manifest.ts` — task manifest format, validator, frozen limits
- `scripts/v019-repo-checkout.ts` — repository clone, checkout, metadata collection
- `scripts/v019-trajectory-collector.ts` — wraps v018 repair loop for real repos
- `scripts/v019-metrics.ts` — pre-registered metrics computation pipeline
- `scripts/v019-failure-taxonomy.ts` — F1-F18 failure classification
- `scripts/v019-task-corpus.ts` — initial 5-task infrastructure validation corpus
- `scripts/run-v019-evaluation.ts` — main evaluation runner with checkpointing
- `scripts/v019-evaluation.spec.ts` — 19 tests covering identity, manifests, metrics, taxonomy

## Testing

typecheck PASS. 19/19 evaluation infrastructure tests PASS covering experiment identity, task manifest hashing and validation, metrics computation (one-shot Flash rate, Pro escalation/rescue, budget stops), and failure taxonomy classification (holdout edge-case, budget exhaustion, provider failure, premature escalation).

## Alternatives considered

**Extend the v018 qualification runner directly.** Rejected because the v018 runner is fixture-oriented with synthetic workspaces; real repositories need clone/checkout, dependency installation, and repository-specific verification commands that would pollute the frozen v018 code.

**Build a separate evaluation framework.** Rejected because the repair loop (`runRepairLoop`) is the experimental control and must be reused unchanged. Wrapping it with injectable turn runners and verifiers preserves the frozen policy while adapting only the I/O layer.

**Start with 75 real tasks immediately.** Rejected because the infrastructure itself needs validation first. The 5-task infrastructure validation corpus verifies clone, checkout, install, turn runner, verifier, trajectory capture, and metrics computation end-to-end before scaling to the full cohort.

## Consequences

The infrastructure freezes the v0.18.0 policy as experimental control and makes every trajectory auditable. The 5-task validation corpus is synthetic; the full 75-task cohort across 8-15 real open-source repositories is the actual evaluation. The failure taxonomy will determine whether v0.19 targets context acquisition, verifier quality, task decomposition, or latency — not feature additions. The discipline of no tuning during collection is enforced by the frozen limits in the experiment manifest.
