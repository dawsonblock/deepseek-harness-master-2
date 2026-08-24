# DeepSeek Harness Full Durable Recovery-Checkpoint Upgrade v0.8.0

v0.8.0 builds on the v0.7 policy-bound verification and crash-lifecycle work.
It does not add another agent layer. It closes the next recovery gap: after a
process restart, the runtime can now identify the last semantic durability
barrier and persist a machine-readable crash-repair receipt that distinguishes
work that can be retried automatically from work that must reconcile external
state.

## 1. Native `session/checkpoint` durability markers

`dsh-session-checkpoint-policy` now appends an ignorable, log-only
`session/checkpoint` event immediately before each canonical
`ctx.sessions.flush()` boundary. The event records:

- schema version 1;
- `basisSeq`, the exact event sequence immediately preceding the checkpoint;
- checkpoint reason (`model-request`, `tool-effect`, `pre-step`, `goal-idle`,
  or `manual`).

A checkpoint recovered from storage is itself proof that the prefix through
`basisSeq` reached durable persistence. This avoids treating an in-memory
"flush attempted" flag as durable evidence.

Repeated semantic barriers over an unchanged prefix reuse the existing marker,
so the policy does not grow the session log simply because pre-step and model
request layers see the same state.

## 2. Machine-readable `session/recovery` receipts

When a persisted checkpointed session ends with an open turn, normal
`interruptedTurnClosers()` repair still emits the canonical model-visible
synthetic tool results plus step/turn closers. v0.8 additionally appends an
ignorable `session/recovery` receipt after those closers.

The receipt records:

- repaired turn / step;
- checkpoint seq and checkpoint basis seq;
- first crash-tail seq and tail event count;
- definitely-not-started calls;
- idempotent retry-safe calls;
- reconciler-required side effects;
- legacy/unclassified ambiguous calls.

The receipt never enters model history. It exists for resume controllers,
operators, telemetry and audit.

Historical/non-checkpointed logs retain the existing repair shape. v0.8 does
not retroactively add recovery-receipt events to old crash fixtures merely
because the reader is newer.

## 3. Recovery classification uses native lifecycle policy

The receipt combines the lifecycle evidence introduced in v0.4-v0.6:

```text
tracked call, no tool/dispatch
        -> definitely not started

tracked + dispatched + idempotent
        -> outcome unknown but safe to retry

tracked + dispatched + reconcile mode
        -> external reconciliation required

legacy/unclassified ambiguous call
        -> fail closed
```

This makes the recovery decision explicit instead of requiring downstream code
to parse the prose inside synthetic `TOOL_NOT_STARTED` or
`TOOL_OUTCOME_UNKNOWN` messages.

## 4. Public recovery-plan projection

`@deepseek-ai/dsh-agent-kernel-hardening` is upgraded to 0.6.0 and exports
`deriveLatestRecoveryPlan(events)`.

The resulting plan is one of:

- `clean` — no outstanding retry work;
- `retryable` — all interrupted work is definitely not-started or idempotent;
- `blocked` — reconciliation or legacy ambiguous side effects remain.

`canAutoResume` is false for the blocked case. The projection preserves the
individual call ids, tool names and operation keys needed for orchestration or
operator review.

## 5. Recovery telemetry

The hardening metrics now include:

- durability checkpoint count;
- recovery receipt count;
- recovered not-started calls;
- recovered retry-safe calls;
- reconciliation-required calls;
- legacy ambiguous calls;
- average crash-tail event count.

These metrics make restart quality measurable rather than binary.

## 6. Real process-kill checkpoint qualification

v0.8 adds a child-process chaos fixture that fsyncs a checkpointed event stream
and is force-killed in four recovery-policy scenarios:

1. tracked call before dispatch;
2. dispatched idempotent call;
3. dispatched reconcile-mode side effect;
4. legacy ambiguous call.

The parent reloads the durable JSONL prefix and verifies the expected recovery
bucket plus checkpoint/tail evidence.

## 7. Native regression fixtures

Dependency-backed CI now has source tests for:

- checkpoint marker creation and `basisSeq` binding;
- checkpoint-marker deduplication over an unchanged prefix;
- repair receipt generation from a checkpointed crash tail;
- preservation of operation keys and recovery-mode buckets.

The clean extracted environment does not contain the complete installed pnpm
workspace dependency graph, so those native Vitest tests are shipped but the
full upstream suite is not claimed here.

## 8. Compatibility and deliberate boundaries

- `session/checkpoint` and `session/recovery` are ignorable, model-invisible
  vocabulary additions; no session format-version bump is required under the
  repository's current event-vocabulary compatibility policy.
- Existing `interruptedTurnClosers` output remains unchanged for historical
  logs that contain no persisted checkpoint.
- The TypeScript Harness remains the only production runtime.
- The Python kernel remains a reference/test oracle.
- `session/recovery` does not itself execute retries or reconciliation; it is a
  durable decision input. Existing tool-owned reconciliation remains the
  authority for side effects.
- A recovery plan marked `retryable` still requires the caller to decide which
  interrupted operations remain semantically necessary for the current goal.

## 9. Next high-value work

1. dependency-backed full monorepo CI and native Vitest execution;
2. wire recovery plans into the configured goal-round resume controller so
   automatic continuation can consume `canAutoResume` directly;
3. first-party acceptance verifiers for tests, artifacts and benchmark gates;
4. additional domain reconcilers for side-effectful first-party integrations;
5. persistence-backend-specific process-kill tests (SQLite/JSONL) rather than
   only the protocol-level fsynced fixture;
6. paired production task experiments measuring restart success-per-cost and
   restart latency.
