# DeepSeek Harness Full Native Autonomy Upgrade v0.5.0

v0.5.0 converts the two most important v0.4 follow-ups from advisory architecture into native production-runtime behavior:

1. autonomous goal completion is independently verified before the goal can transition to `complete`;
2. ambiguous side-effect retries are governed by definition-owned idempotency/reconciliation contracts before body dispatch.

The canonical TypeScript Harness remains production authority. The Python agent kernel remains an executable reference/test oracle only.

## 1. Independent autonomous goal-completion verification

`GoalService` now owns a completion-verifier registry and a durable `goal/verification` event.

- `GoalService.registerCompletionVerifier(...)` registers independent deterministic or externally-backed acceptance checks.
- `GoalService.verifyCompletion(...)` evaluates checks in stable name order.
- verifier exceptions are converted into failed checks rather than bypassing the gate.
- **every registered check must pass**.
- runtime integrity alone is insufficient: at least one deployment-owned objective acceptance verifier must be registered or automatic completion fails closed.
- each verification attempt is persisted as ignorable, log-only `goal/verification` evidence.
- `tool-goal` invokes `verifyCompletion(...)` before `complete(...)` during an autonomous goal round.
- rejection returns `GOAL_TOOL_VERIFICATION_FAILED` and leaves the goal active.
- direct human completion remains an explicit authority override.

An always-on runtime-owned `runtime-integrity` verifier rejects automatic completion when the durable session contains:

- an unresolved non-idempotent `TOOL_OUTCOME_UNKNOWN`; or
- a failed tool result in the active goal round.

Deployments must register at least one objective acceptance verifier when independent completion verification is enabled. These can be deterministic test gates, artifact checks, benchmark thresholds, external-state assertions, or domain-specific evidence.

## 2. Native per-tool idempotency and reconciliation

`ToolDefinition` / `defineTool(...)` now accepts a native recovery contract:

- `mode: 'idempotent'` for operations that may safely execute again;
- `mode: 'reconcile'` plus a mandatory async reconciler for side-effecting operations.

Each recovery-aware call receives a canonical operation identity. Unless a tool supplies a stronger domain key, Harness derives a SHA-256 key from:

- tool name; and
- canonical lossless-JSON arguments with recursively stable object-key ordering.

The agent loop persists `recoveryMode` and `operationKey` on `tool/call`.

Before a reconcile-mode retry dispatches, the runtime scans the durable session for a matching earlier `TOOL_OUTCOME_UNKNOWN` operation and invokes the tool-owned reconciler:

- `completed` -> reconstruct the prior successful canonical value without running the body again;
- `not-executed` -> permit normal dispatch;
- `unknown` -> fail closed with `TOOL_RECONCILIATION_REQUIRED`.

Every decision is written as the ignorable log-only `tool/reconciliation` event.

## 3. First-party recovery declarations

The following read/search operations are explicitly marked idempotent:

- filesystem `read`;
- filesystem `read_image`;
- filesystem search `grep`;
- filesystem search `glob`.

The full-file filesystem `write` tool now has a concrete reconciler. After an ambiguous crash, a matching retry reads current target state before dispatch. If the file content exactly equals the intended full write, the runtime reconstructs success without rewriting the file. If exact state cannot be proven, the retry remains blocked rather than guessing.

This reconciler deliberately does not pretend it can reconstruct the original pre-write content; it proves only that the intended final state already exists.

## 4. Durable vocabulary

The session vocabulary now carries:

- `tool/call.recoveryMode`;
- `tool/call.operationKey`;
- `tool/reconciliation`;
- plugin event `goal/verification`.

These are non-model-visible evidence records and preserve the event-sourced architecture.

## 5. Hardening telemetry

`@deepseek-ai/dsh-agent-kernel-hardening` is bumped to `0.3.0` and now reports:

- reconciliation attempts;
- completed/not-executed/unknown reconciliation outcomes;
- goal-verification attempts;
- verification passes and failures;
- the v0.4 request/cache, tool lifecycle, compaction, recovery, latency, and paired-ablation metrics.

The package remains an observer of the canonical event ledger, not a second execution runtime.

## 6. Regression and release guards added

New upstream regression fixtures cover:

- a completed reconciliation reconstructing the previous value without invoking the side-effect body again;
- an unknown reconciliation blocking redispatch;
- GoalService persisting independent verification and requiring every check to pass;
- autonomous `update_goal(... complete ...)` failing before mutation when an acceptance verifier rejects completion.

A dependency-light source integration guard, `scripts/verify-agent-kernel-v05.mjs`, verifies that the production wiring remains present and ordered, including the critical invariant that autonomous verification occurs before `ctx.goals.complete(...)`.

Root `check:all`, `check:ci`, and `release:verify` now include this v0.5 guard in addition to the hardening package semantic and packed-consumer checks.

## 7. Qualification performed in this archive environment

Passed:

- hardening semantic suite: **15/15**;
- packed clean-consumer import: **PASS**;
- Python reference suite: **12/12**;
- Python `compileall`: **PASS**;
- native v0.5 source-enforcement guard: **PASS**;
- syntax transpilation for modified native source/tests: **20/20**;
- partial project-reference TypeScript typecheck reached the modified tool code after two detected integration errors were fixed; the remaining blockers are missing extracted-environment third-party packages (`zod`, `@standard-schema/spec`, `diff`), not reported errors in the corrected recovery code.

Not claimed:

- a complete upstream pnpm workspace CI pass, because the archive environment does not contain the installed workspace dependency graph;
- execution of the newly added upstream Vitest regression files for the same dependency reason;
- full persistence-catalog generator freshness, because its markdown-parser dependencies are absent. The v0.5 dependency-light guard instead verifies that both new durable event types are present in the canonical known-event vocabulary and documented in the catalog.

## 8. Remaining high-value work

This release intentionally does not add another agent/memory layer. The next meaningful qualification work is failure injection and end-to-end proof:

- crash before dispatch;
- crash after side effect but before durable result;
- reconciler unavailable/incorrect;
- duplicate retry races;
- verifier crash/timeouts;
- verifier disagreement;
- restart during verification;
- full workspace CI with installed dependencies;
- task-level ablations measuring whether stricter verification/reconciliation improves success per cost rather than only safety.
