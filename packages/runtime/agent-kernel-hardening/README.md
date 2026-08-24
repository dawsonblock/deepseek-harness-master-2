# Agent Kernel Hardening

Native replay-derived diagnostics and qualification helpers for DeepSeek Harness sessions. This package **does not create a second runtime, session store, or telemetry pipeline**. It consumes the canonical Harness event log directly, or adapts records already captured by `session-telemetry`.

It provides:

- request-level prefix/cache stability derived from real `model/request` attempts;
- canonical turn outcome metrics (`completed`, `max-tokens`, blocked/error/interrupted separated);
- canonical tool failures from `tool/result.message.content[*].isError`;
- physical tool execution, ordered-commit, and head-of-line latency metrics using `tool/dispatch` + `tool/settled` + `tool/result`;
- successful vs failed compaction accounting;
- backward-compatible unmatched-tool recovery classification;
- optional external reconciliation for ambiguous non-idempotent side effects;
- deterministic quality gates;
- heuristic dashboard scoring plus paired task-level experiment summaries.

## Public package contract

The package builds a real root entrypoint (`lib/index.js`) and declarations (`lib/types/index.d.ts`). `test:packed` performs an `npm pack`, installs the produced tarball into a clean temporary consumer, and imports `@deepseek-ai/dsh-agent-kernel-hardening` through the declared package export.

```bash
npm --prefix packages/runtime/agent-kernel-hardening test
npm --prefix packages/runtime/agent-kernel-hardening run test:packed
```

## Recovery semantics

New native tool calls are dispatch-tracked (`tool/call.lifecycleVersion = 1`):

- tracked `tool/call` with no `tool/dispatch` and no result -> `not-started`;
- tracked `tool/dispatch` with no result -> `outcome-unknown`;
- legacy unmatched calls without lifecycle evidence remain conservatively `outcome-unknown`;
- idempotent unknown outcomes may be retried by policy;
- non-idempotent unknown outcomes require a concrete `reconcile(...)` implementation or remain blocked.

The canonical TypeScript Harness runtime remains the execution authority. In v0.5, the runtime also enforces definition-owned idempotency/reconciliation before a matching ambiguous side effect can redispatch; this package reports the resulting evidence and recovery state.

## Cache stability

`request/header` is intentionally sparse, so it is **not** a valid request denominator. Stability is measured over actual `model/request` attempts, with header snapshots defining prefix epochs. Old sessions without request-attempt lifecycle records return `null` for this metric instead of inventing a misleading estimate.

## Telemetry integration

Use `eventsFromTelemetryRecords(...)` to analyze the existing `session-telemetry` ledger stream. Do not install a second event capture pipeline for this package.

## Ablations

`scoreAblation(...)` remains a transparent dashboard heuristic, not a scientific architecture verdict. For decisions, prefer `summarizeVariant(...)` and `comparePairedVariants(...)` over the same task IDs and report success delta, paired wins/losses, cost per success, tokens, model calls, tool calls, and latency separately.

## v0.5 native enforcement signals

The production TypeScript runtime now owns enforcement rather than leaving recovery and completion as advisory analytics:

- each tool definition may declare `recovery.mode = 'idempotent'` or a fail-closed `reconcile(...)` contract;
- operation keys are SHA-256 identities over tool name plus canonical lossless-JSON arguments unless the tool supplies a stronger domain key;
- retries matching an earlier `TOOL_OUTCOME_UNKNOWN` reconcile before body dispatch;
- a reconciler that proves `completed` reconstructs the prior value without re-running the side effect;
- `not-executed` permits dispatch; `unknown` blocks the retry;
- `tool/reconciliation` records the decision durably;
- automatic goal-round completion calls `GoalService.verifyCompletion(...)` before `complete(...)`;
- the always-on `runtime-integrity` verifier rejects unresolved side effects and failed tool evidence in the current goal round;
- autonomous completion requires at least one explicitly registered objective acceptance verifier in addition to runtime integrity; every registered verifier must pass, and verifier exceptions fail closed;
- `goal/verification` records every automatic verification attempt durably.

Direct human goal completion remains an explicit authority override. The verifier gate is specifically for autonomous goal-round completion.


## v0.6 verified-commit and recovery coverage

The production goal runtime now separates objective acceptance verifiers from supplemental integrity verifiers. Autonomous completion is committed through `GoalService.completeVerified(...)`: the immediately preceding durable event must be a passing `goal/verification` for the exact goal id/revision. Any intervening event invalidates that one-shot authorization and requires re-verification, closing the verification-to-completion gap.

Recovery declarations are also broader for first-party read-only operations: `web_fetch`, `web_search`, `lsp`, and all five `session-query` tools are explicitly idempotent in addition to the filesystem read/search tools already covered. The dependency-free v0.6 failure-injection specification exercises crash-before-dispatch, crash-after-dispatch, legacy ambiguity, stale verification, intervening-event invalidation, and all reconciliation outcomes.

## v0.5.0 additions (Harness full upgrade v0.7.0)

The replay analyzer now measures native Code Mode directly from the existing
`tool/code-dispatch-start` / `tool/code-dispatch` ledger vocabulary:

- outer `run_code` calls;
- nested sub-dispatch starts and settlements;
- nested error rate;
- mean/p95 nested execution latency;
- average nested calls per run;
- durable nested-result bytes kept out of model-visible history.

Goal verification provenance is also stronger in the production goal service.
A v2 `goal/verification` receipt records the pre-verification ledger basis, the
semantic role and optional deployment version of each verifier, and a SHA-256
fingerprint over the exact verifier registry. `completeVerified()` rejects a
passing receipt if the verifier registry has changed since verification. A
verifier implementation that changes behavior should therefore bump its
explicit `version` string.

## v0.8 recovery-plan projection

The package now derives checkpoint/recovery telemetry and exposes
`deriveLatestRecoveryPlan(events)`. It consumes the machine-readable
`session/recovery` receipt rather than parsing synthetic error prose. A plan is
`clean`, `retryable`, or `blocked`; `canAutoResume` is false whenever external
reconciliation or legacy ambiguous side effects remain.

### Outcome receipts (v0.9)

The hardening projection now counts durable `goal/outcome-receipt` proof objects
separately from `goal/verification` attempts, including receipts that passed with
warnings. This separates "verification was attempted" from "an immutable evidence-
backed outcome proof was actually produced."

## v0.10 verifier experiments

The experiment layer can summarize labeled verification observations and compare pack versions using false-acceptance and false-rejection deltas. Use these metrics alongside task success, latency, cost, and token usage; do not collapse verifier safety into the legacy heuristic ablation score.

## v0.14 runtime performance and resource governance

v0.14 adds a performance/resource surface rather than another execution engine:

- `context/composition` measures the current replayed request surface and the
  portion attributable to typed reasoning blocks;
- `runtime/performance-sample` separates turn wall time, model wait, external
  tool intervals, and residual orchestration overhead;
- `terminal/settlement` measures marker-fast-path versus fallback/reset/timeout
  behavior for persistent Bash and PowerShell;
- `runtime/backpressure` measures bounded-queue waits and overload rejection;
- `subagent/resource` records root-wide budget admission/rejection/release;
- `RootResourceGovernor` caps descendants, concurrent one-shot children, start
  rate, model calls, reasoning tokens, event bytes, and aggregate wall time;
- `BoundedBackpressureGate` is a bounded FIFO gate whose queued admissions are
  abortable and whose accepted work is never silently dropped;
- `RUNTIME_PERFORMANCE_GATES` is a required benchmark gate set (15% maximum
  orchestration overhead, 50% maximum p95 reasoning-context share, 5% maximum
  persistent-terminal fallback rate, zero dropped work).

The first-party `runtime-performance-telemetry` plugin emits the context and
turn samples from canonical lifecycle events. Parallel tool durations are
unioned rather than summed, preventing fan-out from inflating external-tool
wall time. The first-party `runtime-resource-governor` plugin connects root
budgets and optional bounded one-shot subagent admission directly to the native
SubagentRuntime admission boundary.

These controls are deliberately process-local. Multi-process deployments need
a shared quota backend or must reconstruct/seed usage from durable telemetry;
v0.14 does not claim distributed quota consensus.

## v0.14.1 runtime hardening corrections

v0.14.1 centralizes the five runtime diagnostic event schemas in the canonical
Session vocabulary and regenerates the persistence catalog. Persistent Bash and
PowerShell no longer independently declare incompatible `terminal/settlement`
payloads.

Performance telemetry now consumes monotonic spans around the actual
`llm/stream` and `tools/execute` seams. The PTY quality gate uses
`terminalProtocolFallbackRate` (prompt + silence) while timeout, exit and reset
rates are exposed independently; the legacy `terminalFallbackRate` field is a
compatibility alias for the protocol fallback rate.

The resource-governor integration also performs fail-closed model-call
admission in `agent/request`, so a configured model-call ceiling is checked
before provider dispatch rather than only being observed after `model/request`.
