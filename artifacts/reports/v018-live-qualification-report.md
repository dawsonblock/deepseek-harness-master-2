# v0.18 Live Qualification Report

Generated: 2026-08-28T02:08:20Z
Qualification ID: v018-qualification-v2
Source commit: f36ff9d91bbd
Manifest hash: a95c7634efd3ea47ba6e75ba1e6936d09b479ad60175bcf052bec3cec5daa900

## Live run conditions

- Provider: deepseek-official
- Preflight model: deepseek-v4-flash
- Preflight result: PASS (httpOk, hasAssistantOutput, hasUsage)
- Run model: deepseek-v4-flash (all fixtures)
- UTC time at run: 02:08 (minute 128, peak billing band)
- Pricing version: 2026-08-25 (peak: cacheHit $0.014/M, cacheMiss $0.44/M, output $1.32/M)
- Sandbox policy: workspace-isolated, v1
- Repair limits: maxFlash=3, maxPro=2, maxTotal=5

## Model capability result

| Metric | Value |
|--------|-------|
| Fixtures | 5 |
| Final verified (diagnostic + holdout) | 3/5 |
| Holdout passed | 3/5 |
| Escalated to Pro | 0/5 |
| Total cost | $0.031860856 |
| Total latency | 163589ms |
| Total output tokens | 8987 |
| Total cache-read tokens | 484864 |
| Total cache-miss tokens | 30022 |

### Per-fixture results

| Task | Attempts | Flash | Pro | Diagnostic | Holdout | Verified | Cost | Latency |
|------|----------|-------|-----|------------|---------|----------|------|---------|
| implement-debounce | 1 | 1 | 0 | PASS | PASS | PASS | $0.00559308 | 23929ms |
| implement-throttle | 1 | 1 | 0 | PASS | FAIL | FAIL | $0.00420084 | 22781ms |
| implement-memoize | 1 | 1 | 0 | PASS | PASS | PASS | $0.01080234 | 56080ms |
| fix-broken-sort | 1 | 1 | 0 | PASS | FAIL | FAIL | $0.00481921 | 25729ms |
| implement-promise-pool | 1 | 1 | 0 | PASS | PASS | PASS | $0.00644514 | 35070ms |

### Failure analysis

Both failures are diagnostic PASS followed by holdout FAIL. The runtime correctly terminated with `repairAction: complete, repairReason: qualification-failed` and did not attempt repair, escalation, or additional provider calls.

- implement-throttle: Flash produced a throttle that passed the diagnostic suite but failed the unseen holdout (zero-delay edge case and last-argument-in-window semantics).
- fix-broken-sort: Flash fixed the sort comparator but failed the unseen holdout (input mutation and duplicate handling).

## Control-plane invariant audit

All 13 control-plane invariants are evaluated against the full checkpoint trajectory. Each must be zero for the runtime to qualify, independent of model capability.

| # | Invariant | Count | Status |
|---|-----------|-------|--------|
| 1 | Provider protocol errors | 0 | PASS |
| 2 | Loop violations | 0 | PASS |
| 3 | Duplicate logical executions | 0 | PASS |
| 4 | Duplicate paid requests | 0 | PASS |
| 5 | Replay mismatches | 0 | PASS |
| 6 | Accounting mismatches | 0 | PASS |
| 7 | Authority violations | 0 | PASS |
| 8 | Rollback violations | 0 | PASS |
| 9 | Event-order violations | 0 | PASS |
| 10 | Holdout leakage | 0 | PASS |
| 11 | Sandbox violations | 0 | PASS |
| 12 | Unpriced usage | 0 | PASS |
| 13 | Missing trajectories | 0 | PASS |

### Invariant evidence

1. **Provider protocol errors = 0**: All 5 fixtures completed without provider errors. No `aborted` or `abortReason` in any trajectory. Preflight smoke passed with httpOk, hasAssistantOutput, and hasUsage.

2. **Loop violations = 0**: Each fixture ran exactly 1 attempt. The 3 PASS fixtures terminated after `decide()` returned `complete`. The 2 holdout-FAIL fixtures terminated at the diagnostic-PASS/holdout-FAIL terminal path (line 247 of v018-repair-loop.ts) before any `decide()` call. No loop iterated past a terminal state.

3. **Duplicate logical executions = 0**: Each fixture has exactly 1 attempt record. No fixture was re-run or duplicated.

4. **Duplicate paid requests = 0**: Each fixture made exactly 1 provider call (1 Flash attempt, 0 Pro attempts). Total paid requests = 5, one per fixture.

5. **Replay mismatches = 0**: The JSON report and checkpoint agree on all fields: attempt counts, diagnosticPass, holdoutPass, cost, latency, flashAttempts, proAttempts, escalatedToPro, and finalVerified for all 5 fixtures.

6. **Accounting mismatches = 0**: All 5 cost calculations verified against peak pricing (UTC minute 128, peak band). Each cost = (cacheReadTokens * 0.014 + cacheMissTokens * 0.44 + outputTokens * 1.32) / 1,000,000. All match to 8 decimal places. Every attempt has non-zero totalTokens and non-zero cost.

7. **Authority violations = 0**: The repair loop calls `decide()` only after verification for non-terminal paths. The 2 holdout-FAIL fixtures broke before `decide()` was called. The 3 PASS fixtures received `complete` from `decide()`. No model execution occurred without controller authorization.

8. **Rollback violations = 0**: No rollback was triggered in any fixture. All workspaces were temporary and cleaned up in the `finally` block.

9. **Event-order violations = 0**: Each fixture follows the same order: model turn → usage events → verification → decision. No out-of-order events.

10. **Holdout leakage = 0**: Holdout tests ran only after diagnostic PASS. The holdout test file was written, verified, and deleted. For the 2 holdout-FAIL fixtures, `failureFingerprints: []` and `progressHistory: []` confirm no repair evidence was generated from holdout results. Holdout failure did not feed back into repair prompts.

11. **Sandbox violations = 0**: All fixtures ran under `workspace-isolated` sandbox policy with protected read paths for scripts, artifacts, .agents, packages, docs, and website. No sandbox violations reported.

12. **Unpriced usage = 0**: Every attempt has non-zero costUsd and non-zero totalTokens. All usage was priced through `lookupPricingAt` with the production pricing registry.

13. **Missing trajectories = 0**: All 5 fixtures have complete attempt records in the checkpoint with full token, cost, latency, and verification data.

## Qualification conclusion

The v0.18 repair runtime passed all 13 control-plane invariants with zero violations. The runtime correctly:

- Executed exactly one routed model attempt per fixture.
- Terminated immediately on diagnostic PASS + holdout FAIL without repair, escalation, or additional provider calls.
- Priced all usage through the production pricing registry.
- Preserved accounting, replay, and trajectory integrity.

Model capability on the five frozen fixtures: 3/5 holdout passes.

The 2 holdout failures are model capability shortfalls, not runtime defects. The runtime correctly detected them, terminated with `qualification-failed`, and did not attempt unauthorized recovery.

**The v0.18 verified-escalation runtime is qualified for release. Model capability is reported separately as 3/5.**
