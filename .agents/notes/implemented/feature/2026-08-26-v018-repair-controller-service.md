# Agent Note: v0.18 RepairController — Pure Repair Decision Service

Status: implemented

English | [中文](2026-08-26-v018-repair-controller-service.zh.md)

## Problem

The v0.17.4 experiment proved that Flash + objective verification + iterative repair with bounded Pro escalation is a better policy than a single Pro attempt on the benchmark. But that result lives in `scripts/` — a standalone experiment runner with no durable state, no session-event provenance, and no runtime integration. The verify-and-repair loop is not yet a DeepSeek Harness capability.

The runtime needs a pure decision service that separates **what happens next** (policy) from **executing the decision** (agent loop), **verifying the result** (verifier), and **recording what happened** (session ledger). Without that separation, repair logic collapses into the agent loop and becomes impossible to test deterministically or reconstruct after a crash.

## Decision

v0.18 introduces `@deepseek-ai/dsh-repair-controller` — a pure Cordis service that decides the next action after a verification result. The service holds no state, calls no models, mutates no files, and writes no events. The agent loop orchestrates the controller; the controller does not orchestrate the loop.

### Interface

```ts
interface RepairController {
  decide(input: RepairDecisionInput): RepairDecision;
}
```

`RepairDecisionInput` carries the attempt history, latest failure package, cost/time budget, and runtime-owned limits. `RepairDecision` is a discriminated union: `complete`, `flash-repair`, `pro-escalate`, or `stop`.

### First runtime policy (v0.18 verified-escalation)

```text
Flash #1 → verify
  pass → complete
  fail → Flash #2 with evidence
Flash #2 → verify
  pass → complete
  fail + same/no-progress → Pro
  fail + progress → Flash #3
Flash #3 → verify
  pass → complete
  fail → Pro
Pro #1 → verify
  pass → complete
  fail → Pro #2
Pro #2 → verify
  fail → stop (pro-exhausted)
```

Hard limits are runtime-owned: max 3 Flash, 2 Pro, 5 total. No model may increase its own attempt limit.

### Durable events

Four new `SessionEventMap` members via declaration merging:

- `repair/evidence` — failure evidence for one attempt.
- `repair/decision` — one controller decision.
- `model/escalation` — explicit Flash→Pro escalation with repair provenance.
- `repair/completed` — task-level accounting (attempts, cost, latency).

The `model/escalation` event gives `RoutingOutcome` explicit repair provenance instead of inference: `fromRoutingDecisionId`, `toRoutingDecisionId`, `repairOf`, `fromModel`, `toModel`, `reason`, `failureFingerprint`, `flashAttempts`.

### Separation from provider retry

Provider retry (503, timeout, connection failure) is a same-logical-attempt concept. Task repair (model completed but verification failed) is a new-logical-attempt concept. The repair loop does not replace or extend provider retry logic.

### Opt-in

Repair is opt-in via cordis.yml config. v0.18 does not silently change every existing Harness workflow.

## Realization

- Package: `packages/core/repair-controller/`
- Types: `src/types.ts` — `ModelRef`, `RepairAttempt`, `RepairDecision`, `RepairDecisionInput`, `RepairLimits`, event payload types.
- Pure decision: `src/decide.ts` — `decideRepair()`, `computeFailureFingerprint()`, `classifyProgress()`.
- Service: `src/index.ts` — `RepairControllerService extends Service`.
- Events: `src/events.ts` — declaration merging for four new event types.
- Tests: `tests/decide.spec.ts` — 16 deterministic tests covering all 8 policy scenarios plus edge cases.

## Verification

- 16 deterministic tests pass: Flash→pass, Flash fail→repair pass, same-failure escalation, partial-progress→Flash #3, Flash×3→Pro, Pro×2→stop, attempt-limit, regression→Pro, edge cases.
- Typecheck clean.
- Lint clean.
- No API tokens consumed — all tests are keyless and deterministic.

## Consequences

- The agent loop must be modified to call `RepairController.decide()` after verification and execute the returned action. That integration is the next step.
- Crash/replay durability tests must verify that repair state reconstructs deterministically from the session log after a process kill.
- The five live sandboxed holdout fixtures remain the final qualification gate before enabling the policy in normal runtime execution.
