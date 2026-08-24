# Agent Execution Kernel Upgrade — v0.2.0

This repository includes an additive reference package at:

`python/agent-kernel-ref/`

It remains deliberately isolated from the existing DeepSeek Harness TypeScript runtime. The package captures and hardens the execution semantics identified as highest leverage for robust long-horizon agents without creating a second production source of truth.

## v0.2.0 hardening

The second upgrade fixes real durability and qualification gaps found in v0.1.0:

1. **Durable goal rehydration** — `GoalStore` now reconstructs goals from `goal/update` events after a process restart instead of relying on a Python in-memory dictionary.
2. **Goal resume** — `AgentKernel.resume_goal()` can reactivate a blocked/incomplete goal from a fresh process while preserving completed rounds and evidence.
3. **Three-stage tool lifecycle** — tool work now records `PLANNED -> DISPATCHED -> COMPLETED|FAILED`.
4. **Correct crash classification** — recovery distinguishes `NOT_STARTED` from `OUTCOME_UNKNOWN`; a non-idempotent dispatched call is not automatically safe to retry.
5. **Idempotent result reuse** — deterministic idempotent calls can reuse an already completed result for the same session/turn/step/call identity rather than re-executing the side effect or read.
6. **Replay-derived telemetry** — token/cache metrics, retries, tool errors/reuse, compaction activity, verifier outcomes, and request-header churn are derived from the event ledger.
7. **Model attempt events** — every model attempt records `model/request`, `model/response`, or `model/error`, so retry behavior is observable.
8. **Compaction protocol safety** — compaction will not leave an orphan tool result visible after compacting away the assistant message that issued the call.
9. **Compaction gain metrics** — compaction events now record before/after estimated token pressure and estimated tokens saved.
10. **Clean extracted-package testing** — pytest is configured for the `src/` layout, so the documented test command works without an editable install.
11. **Expanded qualification suite** — 12 tests now cover ordering, barriers, replay, filesystem CAS, Code Mode, restart recovery, idempotency, compaction protocol validity, retries/telemetry, and goal resume.

## Core mechanisms retained

- immutable SQLite/WAL event-sourced session state
- model-visible surface projection derived from durable events
- replayable compaction using `surface/replace`
- canonical request envelopes and stable tool ordering
- concurrency-aware tool scheduler with exclusive mutation barriers
- model-order result commit even when safe tool calls finish out of order
- deterministic tool-output pruning and pressure-triggered checkpoint compaction
- filesystem observation and stale-version guards
- bounded retry with exponential backoff and jitter
- goal rounds with independent verifier interfaces
- isolated child-session subagents
- Code Mode reference runtime whose inner tool calls re-enter the ordinary tool scheduler

## Why it is additive

DeepSeek Harness already implements several of these semantics in TypeScript. Replacing them with a parallel Python runtime would create two sources of truth and weaken the project. This package is therefore a reference and experimentation kernel for:

- ablation studies
- porting mechanics into another AI/DAG runtime
- testing alternate execution policies
- building graph/memory/evidence SDK adapters
- validating durability invariants before porting them to production TypeScript

## Production integration order

Do not integrate everything simultaneously. Use this order:

1. event-ledger invariants and deterministic replay
2. canonical request/prefix stability metrics
3. tool lifecycle + barrier scheduler + ordered commits
4. context pruning/compaction metrics and transcript-validity checks
5. filesystem CAS/version guards
6. crash reconciliation and idempotency rules
7. durable goal state + independent verifier
8. Code Mode with a hardened sandbox
9. isolated subagents
10. DAG/memory/evidence SDK adapters

## Qualification gates

Measure each layer by ablation. At minimum track:

- final task success
- input/output tokens per task
- cached-input-token ratio
- model attempts per task
- tool calls per task
- tool reuse rate
- tool error rate
- repeated-tool rate
- stale-write rejection rate
- wall-clock latency
- cost per task
- recovery success rate
- compactions per task
- estimated tokens saved by compaction
- verifier pass/fail rate
- goal rounds per task
- request-header churn

Do not infer improvement merely from architectural complexity.

## v0.3.0 — native Harness hardening layer

The full repository now includes `packages/runtime/agent-kernel-hardening`, a read-only TypeScript analysis layer for canonical Harness session events. It intentionally does not introduce a second durable state machine or modify the session wire format. The package derives recovery state, request-prefix churn, cache usage, latency, tool/turn failure metrics, deterministic qualification gates, and ablation rankings directly from the immutable event log.

This closes the largest gap left by the Python reference implementation: the upstream TypeScript Harness can now measure whether its event sourcing, ordered concurrency, stable request headers, cache behavior, compaction, and retry semantics are actually improving execution rather than assuming that architectural complexity implies quality.
