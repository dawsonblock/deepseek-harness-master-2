# Agent Note: Durable model-selection control plane correctness

Status: implemented

English | [中文](2026-08-23-durable-model-selection-control-plane.zh.md)

## Problem

v0.15.4 introduced `ModelSelectionState` as the durable authority for who owns a session's model selection (manual vs auto, which authority, which route). The design was correct, but three seams between the systems were broken:

1. **The authority event was marked ignorable.** `model/selection-authority` was appended with `{ ignorable: true }`, contradicting the session-log contract (`dsh-session/types.ts`): `ignorable: true` means "purely informational and cannot affect reconstruction," and an older reader may skip the event. But `model/selection-authority` IS reconstruction — it determines manual vs auto, who owns selection, and which manual model is active. An older runtime that does not know the type would silently drop a manual Pro selection and reconstruct the session as if the claim never happened.

2. **Auto could resurrect a stale model after restart.** The Host resolver (`api-proxy.ts` `selectionFor`) honored durable manual state but ignored durable auto state, falling through to the request header. After a manual foreign selection → request → Auto → restart, the durable state says auto but the request header still carries the foreign route, so the stale foreign model came back.

3. **Model selection was not crash-durable on storage.** `selectModel` appended the authority event and returned RPC success without flushing persistence. With the write-behind buffer (`DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200`), a SIGKILL within that window lost the selection from disk. The RPC response was not a commit boundary.

## Decision

**P0-1: `model/selection-authority` is a required event.** Removed `{ ignorable: true }` from the append in `dsh-agent/authority.ts`. The persistence read path (`session-persistence/coordinator.ts` `assertEventsSupported`) already refuses a log containing an unknown non-ignorable event type, so an older runtime that does not know `model/selection-authority` now rejects the session instead of silently dropping the claim. A static gate (`verify-model-state-events-not-ignorable`) mechanically prevents future regressions.

`model/routing-decision` remains ignorable. It carries router optimization continuity (which model was last picked), not ownership. Losing one only restarts the router fresh on the next turn; it does not override user ownership. Ownership protection comes exclusively from `model/selection-authority`. `reconstructRoutingState` calls `reconstructSelectionState` first and returns immediately when a manual authority state exists — routing-decision events are only scanned for legacy compatibility (pre-v0.15.3 sessions) or current-policy route continuity under auto.

**P0-2: durable Auto is authoritative.** The Host resolver now treats the durable `ModelSelectionState` as the sole authority source once any supported state event exists. Manual → exact durable selection. Auto → deployment default (the router middleware overrides on top). Undecidable (future-schema or malformed) → hard error (fail closed). The request header is a legacy fallback only when no `model/selection-authority` event exists. Once any supported state exists, the request header stops being an authority source — eliminating the stale-model resurrection.

**P0-3: the RPC response is the commit boundary, and flush failure quarantines the session.** `selectModel` now calls `ctx.sessions.flush(session)` before returning success, so the authority event reaches persistent storage before the caller is told it succeeded. If flush fails, the RPC returns a `session-persistence-failed` error and the session is quarantined: a `persistenceFailed` set in the api-proxy closure tracks sessions whose durability barrier failed, and the `agentFor` guard rejects all further operations against them. The in-memory session retains the event — the event is already in the log, and a teardown flush may still persist it — but the caller knows the selection was not durably committed, and no further execution can proceed under a model selection the caller was told did not commit. Recovery is a process restart: the next cold resume reads durable storage, which either has the event (the selection is real) or does not (the pre-mutation state applies). The quarantine is not a transactional rollback; it is a fail-closed condition that prevents the split-brain window from causing unsafe execution.

## Testing

- `authority.spec.ts`: a regression test asserts `model/selection-authority` events appended by `claimModelSelection`/`releaseToAuto` never carry `ignorable: true`, proving the contract that makes an older runtime refuse the log.
- `coordinator-contract.ts`: a persistence compatibility test appends a real `model/selection-authority` event (without `ignorable`), persists it, reloads it, and verifies the loaded event has no `ignorable` field — proving the on-disk shape is the required-event shape that `assertEventsSupported` rejects on an older runtime.
- `api-proxy-models.spec.ts`: two restart-simulation tests prove durable Auto survives a stale foreign request header (foreign-model passthrough) and resolves to the deployment default without a router plugin. A flush-failure test proves `selectModel` returns a `session-persistence-failed` error and quarantines the session (subsequent operations reject). An execution-blocking test proves a quarantined session cannot `prompt` — the guard rejects before any `agent/request` or `llm/request` fires. A disposal-survival test proves the quarantine is not cleared by agent teardown/HMR.
- `rpc-schemas.spec.ts`: a schema test proves the Zod discriminated union accepts `session-persistence-failed` with `{ sessionId }` details and rejects it when details are missing.
- `model-router.spec.ts`: a full request-waterfall test proves Manual ForeignModel → request/header → Auto → router restart → the stale foreign route never reaches `llm/request`; the router selects the fast route, and the foreign model never appears in any LLM request.
- `jsonl.spec.ts` and `sqlite.spec.ts`: real two-process durability tests for both official persistence backends. Each fixture process mounts the backend, performs the model-selection mutation, flushes, prints a success marker, and is SIGKILLed immediately after the marker — no arbitrary post-success sleep. A second process mounts the same storage location and validates the durable state from disk. Covers manual selection, Auto release, manual reselection, foreign-route resurrection, and flush-failure followed by SIGKILL and reload (the reloaded state is a valid complete state, either old or new, never malformed). JSONL: 5/5 scenarios pass. SQLite: 5/5 scenarios pass. Combined: 10/10.
- `verify-model-state-events-not-ignorable`: a static gate scanning 1,254 source files, verified to catch the original defect and pass after the fix.

## Alternatives considered

**Make `model/routing-decision` required too.** Rejected: it carries route optimization continuity, not ownership. `reconstructRoutingState` calls `reconstructSelectionState` first and returns immediately for manual states; routing-decision events only contribute under auto (current-policy route continuity) or for legacy sessions. Making every routing decision a required session-format event would mean an old runtime cannot open a session merely because it does not understand newer router telemetry — moving the design backward. Ownership lives exclusively in `model/selection-authority`.

**Generic "reconstruction-critical events not ignorable" gate.** Rejected: a gate that tries to infer whether some `reconstruct*` function reads an event type is fragile. The gate uses an explicit allow-set of semantic state event types (`model/selection-authority` today), renamed to `verify-model-state-events-not-ignorable` to keep the set honest. The longer-term solution is event metadata (`semantics: 'state' | 'modelVisible' | 'telemetry' | 'observation'`) that makes the rule enforceable without a hardcoded set.

**Transaction-like rollback on flush failure.** Rejected: the event is already in the in-memory log after append; `flush()` does not give transactional rollback. The response contract (RPC fails → caller knows the selection was not durable) is the correct boundary. The in-memory session retains the event for a teardown flush — a documented split-brain window, not a silent inconsistency.

## Consequences

Model-selection state is authoritative, durable, and fail-closed across restart. An older runtime refuses a session with a `model/selection-authority` event it does not understand, rather than silently dropping user authority. Durable Auto overrides the stale request header. A successful `selectModel` RPC response implies the selection survived immediate process death. A failed durability barrier quarantines the session — no further execution proceeds under a selection the caller was told did not commit.

The flush barrier adds one awaited persistence drain per `selectModel` call. The write-behind buffer still applies to non-selection events; only model-selection mutations pay the synchronous barrier cost, which is acceptable for a low-frequency user action.

The quarantine is a process-scoped fail-closed condition, not a transactional rollback. The in-memory session retains the appended event, but the session is unusable until process restart. A future v0.16 may introduce a storage primitive with stronger commit semantics if the window proves operationally costly.

The P0 implementation is code-complete and release-qualified. The targeted behavioral tests, RPC schema tests, quarantine execution-blocking and disposal-survival tests, static gate, translation-pair verification, and real two-process SIGKILL durability tests (JSONL and SQLite, 10/10 scenarios) all pass. The complete TypeScript build produces zero errors. Snapshot refresh passes 128/128; snapshot replay passes 124/128 with 4 pre-existing non-deterministic failures (parallel `tool/settled` event ordering and `durationMs` timing variance) unrelated to these changes.
