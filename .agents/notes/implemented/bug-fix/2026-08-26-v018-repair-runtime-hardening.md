# Agent Note: v0.18 Repair Runtime Hardening

Status: implemented

English | [中文](2026-08-26-v018-repair-runtime-hardening.zh.md)

## Problem

The [v0.18 RepairController](../../implemented/feature/2026-08-26-v018-repair-controller-service.md) ships correct, deterministic decision logic: `decideRepair`, `classifyProgress`, `computeProgressMetrics`, `computeFailureFingerprint`, `computeFailurePackageId`, and the Flash #1→#2→#3→Pro escalation policy are all pure, tested, and replay-stable. The [v0.17.4 experiment](../../implemented/feature/2026-08-25-v0174-flash-failure-pro-repair.md) proved the policy's economic value.

The runtime integration boundary between that controller and real execution is broken. The controller makes correct decisions; the runtime does not execute them through the durable routing authority, does not record real execution history, does not reconstruct complete state after restart, and does not distinguish diagnostic from holdout verification. The result is that repair decisions, model routing, verification, replay, accounting, and the session log describe different histories.

The specific defects, verified against the current source:

1. **Fabricated routing identity.** `handleVerificationFailure` invents `toRoutingDecisionId: \`pro-${state.repairId}-${state.proAttempts}\`` instead of creating a real routing decision through `llm-model-router`. Both `pro-escalate` and `flash-repair` call `agent.followup()` without binding through the routing authority. The durable event chain references IDs that no `model/routing-decision` event produced.

2. **Missing completion on PASS.** The plugin returns early on `goal/verification` PASS and never emits `repair/completed`. The completion event is only emitted inside `handleVerificationFailure`, which is called exclusively on FAIL. Integration tests manually append `repair/completed` to work around this.

3. **Replay mutates attempt identity.** `reconstructRepairState` changes an earlier Flash attempt's model to `proModel` when it encounters a later `pro-escalate` decision. A repair decision is not a model execution attempt; replay must reconstruct attempts from `model/routing-decision` → `model/request` → `model/usage` → `goal/verification` and overlay repair events as annotations.

4. **Timestamp-derived `repairId`.** `repairId` is `repair-${goal.id}-${Date.now()}`, so a crash/replay produces a different ID and cannot match prior durable events. `failurePackageId` is already deterministic (SHA256 of session+turn+routingDecisionId) and integration-tested for replay stability.

5. **Incomplete replay state.** `reconstructRepairState` rebuilds attempts without the `failurePackage` field. After restart, `lastAttempt?.failurePackage` is `undefined`, so `classifyProgress(priorFailure, failure)` returns `'none'` via the `priorEvidence === undefined` branch. The progress-aware Flash #3 policy breaks on replay even though the live path works.

6. **No canonical usage accounting.** `handleVerificationFailure` hardcodes `costUsd: 0, latencyMs: 0`; `state.totalCostUsd` is never incremented. The `RepairLimits.maxTaskCostUsd` and `maxElapsedMs` checks in `decideRepair` exist but are unreachable because the budget is always zero.

7. **No holdout separation in runtime.** The qualification scripts separate diagnostic from holdout verification (`verifyWorkspace` vs `holdoutVerify`, `diagnosticPass`/`holdoutPass`). The production runtime plugin treats all `goal/verification` FAIL identically. A holdout failure can feed evidence into repair prompts.

8. **Model authority not wired.** `decideRepair` infers Pro via `isPro(a.model, input.currentModel)`. The runtime hardcodes `manualModelSelection: false` and `proModelAvailable: true`, never reading the router's `ModelSelectionAuthority` or `markExplicitModelSelection`. A manual Flash task can silently escalate to Pro.

9. **Reconstruction-critical events marked ignorable.** All four repair events are emitted with `{ ignorable: true }`, including `repair/evidence` and `repair/decision`, which `reconstructRepairState` reads to resume correct execution.

10. **No sanitization of model-visible evidence.** `renderRepairPrompt` and `renderProEscalationPrompt` dump raw failure evidence into prompts with no stripping of secrets, absolute paths, credentials, or holdout material.

## Decision

Harden the runtime boundary so execution truth, replay truth, accounting truth, and event-log truth agree. The work is grouped into P0 (steps 1–5), P1 (steps 6–15), and P2 (steps 16–24). P0 and P1 are implemented and tested. P2 qualification is complete except for live fixture execution, which requires `DEEPSEEK_API_KEY`.

### Not reimplemented

The following are already correct and tested and were not duplicated or replaced:

- `computeFailurePackageId` — deterministic, replay-stable, integration-tested
- `classifyProgress` — implements resolved/partial/regression/none precedence
- `computeProgressMetrics` — computes Jaccard similarity and resolved/new failure counts
- `decideRepair` Flash progress-aware escalation policy — Flash #1→#2, #2-progress→#3, #2-repeat→Pro
- `RepairLimits` cost/time fields — `maxTaskCostUsd`, `maxElapsedMs`, `maxOutputTokens`
- `decideRepair` cost/time budget checks
- Qualification-script diagnostic/holdout types — `VerifyResult.diagnosticPass`/`holdoutPass`

The work is at the runtime, replay, and integration boundaries — not in the controller.

### P0 — execution authority, completion, attempts, identity, replay state

**Step 1: Repair execution authority.** `pro-escalate` and `flash-repair` create a real routing decision through `llm-model-router` before calling `agent.followup()`. The `model/escalation` event's `toRoutingDecisionId` references the actual `routingDecisionId` from that decision. Manual model selection (`markExplicitModelSelection`, `reconstructSelectionState`) remains authoritative unless a policy explicitly permits escalation. Integration tests assert that `repair/decision = pro-escalate` produces a real Pro `model/request`, and that `flash-repair` produces a real Flash `model/request`.

**Step 2: Repair completion on PASS.** When an active repair exists and `goal/verification` PASS arrives, the plugin emits `repair/completed` with the final routing decision, total attempts, Flash/Pro counts, final verification state, and cumulative cost, then clears in-memory repair state. Tests cover normal completion, Flash repair completion, Pro takeover completion, and completion after restart.

**Step 3: Separate attempts from decisions.** `reconstructRepairState` reconstructs attempts from real execution events (`model/routing-decision` → `model/request` → `model/usage` → `goal/verification`), overlaying `repair/evidence`, `repair/decision`, and `model/escalation` as annotations. The logic that mutated an earlier Flash attempt's model to Pro based on a later `pro-escalate` decision is removed.

**Step 4: Deterministic `repairId`.** The `repairId` is `repair:v1:<sha256(sessionId + goalId + goalRevision + originatingRoutingDecisionId)>`. The version prefix prevents future identifier schemes from colliding. The existing deterministic `failurePackageId` is preserved. No separate `escalationId` exists; escalation provenance references the real destination routing decision from Step 1.

**Step 5: Complete replay state.** `reconstructRepairState` reconstructs the full `FailurePackage` on each failed attempt, not just the fingerprint. The progress-aware Flash #3 decision is identical before and after restart. Critical test: Flash #1 fails with {A,B,C,D}, Flash #2 fails with {A,B} (partial progress), crash, restart, Flash #3 decision matches the uninterrupted execution's decision.

### P1 — holdout, accounting, budgets, authority, evidence, provenance, rollback, events, ordering, idempotency

**Step 6: Holdout separation in runtime.** The diagnostic/holdout distinction from `scripts/v018-repair-loop.ts` is ported into the production runtime plugin. Diagnostic FAIL creates `repair/evidence` and calls `RepairController`. Diagnostic PASS + holdout PASS completes. Diagnostic PASS + holdout FAIL is a terminal qualification failure: `RepairController` is not called, zero further provider calls, holdout result never becomes model-visible evidence. Regression test: `providerCallsBeforeHoldout === providerCallsAfterHoldout` after holdout failure, plus zero `repair/evidence`, `repair/decision`, and `model/escalation` events for that transition.

**Step 7: Canonical usage accounting.** Each logical attempt references real `model/usage` events. Aggregation covers `cacheReadTokens`, `cacheMissTokens`, `outputTokens`, timestamps, provider/model, and pricing version. Repair cost is derived from canonical usage only. Invariants: total attempts = Flash + Pro; task cost = sum of usage-event costs; every paid usage belongs to exactly one logical attempt. Preserved across replay.

**Step 8: Budget reachability and authority ordering.** Step 7 supplies real `totalCostUsd`/`elapsedMs` into the existing `RepairBudget`, making the existing `decideRepair` budget checks reachable. Decision ordering: verified → hard task-level prohibition → budget exhausted → attempt limit exhausted → determine candidate action → authority + model availability gate. Manual authority controls which model/action is permissible; budget controls whether any further paid execution is permissible. A manual Pro selection does not make `maxTaskCostUsd` irrelevant; `cost-limit` takes precedence over another attempt regardless of model authority.

**Step 9: Model authority rules.** The runtime distinguishes `initialModel`, `flashModel`, `proModel`, `currentModel`, and manual/durable selection source. It does not infer Pro by comparing an attempt against `currentModel`. `manualModelSelection` and `proModelAvailable` are wired from the router's `ModelSelectionAuthority`. Tests cover manual Flash, manual Pro, Auto Flash→Pro escalation, missing Pro route, provider unavailable, and durable state replay. A manual Flash task does not silently jump to Pro unless policy explicitly permits it.

**Step 10: Failure evidence immutability and sanitization.** Once persisted, a `FailurePackage` is never modified; every failed attempt gets a new package. Pro receives the latest failed package with prior packages referenced separately. Sanitization removes API keys, Bearer tokens, passwords, database URLs, credentials, host absolute paths, internal IDs, and holdout material before evidence becomes model-visible. A full durable evidence record and a smaller sanitized model-visible projection are kept.

**Step 11: Workspace provenance.** The runtime records added, modified, and deleted files and before/after workspace-root hashes. It does not rely only on editor-tool calls; Bash and scripts can modify files without appearing in that list. If rollback is supported, a real checkpoint is restored and the restored workspace hash is verified before continuing.

**Step 12: Rollback as runtime action.** `ROLLBACK_AND_REDO` means the Harness restores the checkpoint itself. `repair/rollback` is emitted with from/to workspace hashes. Only after restoration succeeds does the next model run. Rollback is not inferred from model output.

**Step 13: Event semantics.** Events are classified as observability-only versus reconstruction-critical. `repair/evidence`, `repair/decision`, `model/escalation`, and `repair/completed` are reconstruction-critical and are not broadly ignorable. `repair/rollback` semantics are defined. `known-event-types.ts` and persistence/catalog derivatives are regenerated.

**Step 14: Event-order invariants.** The runtime enforces `goal/verification` FAIL < `repair/evidence` < `repair/decision`. For Pro takeover, `repair/decision` < real `model/routing-decision` < `model/request`. `model/escalation.toRoutingDecisionId` matches a real `model/routing-decision` event. Missing events, duplicate decisions, duplicate escalations, and mismatched model tiers are detected.

**Step 15: Idempotency at side-effect boundaries.** Crash after evidence, after decision, after escalation, after request/usage, after verification — on restart, execution continues exactly once. Critical test: a persisted Pro escalation followed by process restart results in exactly one Pro provider invocation (not one `model/escalation` event, one actual provider call).

### P2 — sandbox, verification hardening, fixtures, qualification, freeze

P2 covers sandbox qualification semantics (PASS/FAIL/not-run distinction), expanded adversarial tests, verification anti-cheating, fixture freezing, durable qualification persistence, preflight gate, five-fixture live qualification, v0.18 freeze with manifest regeneration, and post-release real repository evaluation. P2.1–P2.11 are implemented and tested. P2.12–P2.14 (live fixture execution, control-plane vs model capability separation under live conditions, and manual trajectory audit) require `DEEPSEEK_API_KEY` and are pending key availability.

## Alternatives considered

- **Reimplement the controller.** The controller's decision logic, progress classification, and deterministic ID derivation are correct and tested. Reimplementing them duplicates work, risks regressions, and obscures the real defect location: the runtime boundary. Rejected.

- **Add compatibility shims for old `repairId` format.** The pre-release stance in AGENTS.md permits renaming and repackaging freely with no external consumers. Backends reject old on-disk formats. A shim would preserve a broken identity scheme for no consumer. Rejected.

- **Keep `ignorable: true` on reconstruction-critical events.** This makes replay depend on a build's tolerance for missing events, which varies across consumers. Reconstruction-critical events must be required-on-read unless they carry `ignorable: true` for a structural-format reason. The current broad `ignorable: true` is a bug, not a design choice. Rejected.

- **Separate `escalationId` from routing decision identity.** An escalation is a routing transition; its identity is the destination routing decision. A separate ID creates a join that no event produces and that replay cannot reconstruct. Rejected in favor of referencing the real `toRoutingDecisionId`.

- **Let manual authority bypass hard budgets.** Manual authority controls model permissibility, not whether paid execution is permissible at all. A task over its cost ceiling stops regardless of which model the user selected. Rejected.

## Consequences

### What the trade-off cost

- **Routing authority integration changed the agent loop's request path.** Binding repair decisions through the routing authority required a new extension point rather than a direct `agent.followup()` call.
- **Event schema changes.** Adding `repair/rollback`, changing `ignorable` semantics, and making reconstruction-critical events required-on-read required format version consideration. Both TypeScript and Python SDK expected outputs were updated.
- **Deterministic `repairId` changes the on-disk identity.** Existing session logs with timestamp-derived `repairId` values do not match reconstructed IDs. The pre-release stance permits this: backends reject old on-disk formats. Any in-flight repair sessions must complete before the upgrade.
- **Holdout separation requires verifier cooperation.** The runtime plugin needs to know whether a `goal/verification` check is diagnostic or holdout. If the verifier does not tag checks with this distinction, the runtime cannot separate them without a new verification protocol field.

### What it bought

- **Execution truth, replay truth, accounting truth, and event-log truth agree.** Repair decisions, model routing, verification, replay, accounting, and the session log describe the same real execution history.
- **P0 verified:** `repair/decision = pro-escalate` produces a real Pro `model/request` with a `routingDecisionId` that matches `model/escalation.toRoutingDecisionId`. `flash-repair` produces a real Flash `model/request`. `goal/verification` PASS with an active repair emits `repair/completed` and clears in-memory state. `reconstructRepairState` does not mutate attempt model tiers. `repairId` is deterministic across restart. Full `FailurePackage` objects are reconstructed. Flash #3 decision after restart matches uninterrupted execution. Manual model selection is respected.
- **P1 verified:** Holdout failure produces zero further provider calls and zero repair events. `state.totalCostUsd` reflects real `model/usage` costs; `cost-limit` is reachable. `decideRepair` ordering places budget before candidate-action and authority gating after. Model-visible evidence is sanitized; durable evidence retains full content. Reconstruction-critical repair events are not broadly ignorable. `model/escalation.toRoutingDecisionId` matches a real `model/routing-decision` event. Persisted Pro escalation + restart = exactly one Pro provider invocation.
- **P2 verified (offline):** Sandbox qualification distinguishes pass, fail, and not-run; a not-run mandatory test does not produce a qualified backend. 318 tests across 21 test files pass. The qualification manifest is frozen with fixture hashes, model routes, repair limits, and sandbox qualification identity. The persistence event catalog includes all five repair events.
- **P2 pending (live):** Five-fixture live qualification, control-plane vs model capability separation under live conditions, and manual trajectory audit require `DEEPSEEK_API_KEY`. v0.18 freeze and `FULL_FILE_MANIFEST.sha256` regeneration follow live qualification.
