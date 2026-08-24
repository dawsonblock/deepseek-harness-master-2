# DeepSeek Harness FULL Upgrade v0.15.1

## Release objective

v0.15.1 is the focused router-hardening release responding to the external audit of v0.15.0. The audit confirmed the tiered-routing architecture (the `agent/request` seam, within-turn stability, foreign-route authority) and rejected the v0.15.0 *policy* for specific, demonstrated defects. This release fixes every actionable item on that list: routing-authority correctness, scorer calibration, durable routing telemetry, restart safety, mid-turn adaptivity, multilingual vocabulary, lazy evaluation, cloud-catalog hygiene, SSE idle-timeout completion, a packed-consumer build gate, and an explicit release guard in the root CI chains. No new subsystems; the event-sourced kernel, governor, and enforcement policy remain intact.

## The audit's findings and their fixes

### 1. Authority bug: explicit Pro after router-owned Pro was downgraded (fixed)

The v0.15.0 router inferred heavy-route ownership from model equality alone, so an operator's explicit Pro selection made right after a router escalation could be re-scored and downgraded on an easy turn. v0.15.1 replaces inference with provenance, at two layers:

- **Live provenance.** `@deepseek-ai/dsh-agent` now exports `markExplicitModelSelection(session)` / `explicitModelSelectionMark(session)`. Only a deliberate in-process selection earns the mark — the web model picker's setter (`api-proxy.ts`) marks; the log-derived fallback read deliberately does not. A marked session is not router-managed at all: explicit Flash is never escalated, explicit Pro is never downgraded, and the transition is recorded durably.
- **Continuity proof.** Without a mark, a heavy proposal counts as router-owned only when it field-wise equals the config the router itself returned last turn (`callConfigEquals`), or when the router's own durable decision history proves ownership. Model equality alone is never proof.

### 2. Scorer contradicted its calibration contract (fixed)

v0.15.0's README promised "any single family is capped and cannot escalate alone" while family caps (9/8/8/3/4) sat at or above the threshold (4). The audit demonstrated: "Refactor the distributed architecture." scored 6 → Pro; "Prove the theorem." scored 4 → Pro; 1,600 meaningless characters scored 4 → Pro — a denial-of-wallet surface at Pro's ~3.1× price. v0.15.1's scorer holds every cap strictly below the threshold, machine-verified by `noFamilyAloneReaches` in tests and the release guard. The audit's exact prompt table is now a regression test: every single-family row stays on Flash ("Prove the theorem." = 2, "Fix the race condition in the scheduler." = 0, 1,600 padding chars = 2); escalation requires cross-family corroboration ("Prove the theorem. Think step by step." = 5).

### 3. Length alone forced Pro (fixed)

Length bands are now 800 characters (was 400) with a cap of 2 — long-but-trivial input can never escalate, at any length.

### 4. No reaction to discovered complexity (fixed: one-way mid-turn escalation)

v0.15.0 locked a turn's route at step 1, so "Fix the bug." → Flash stayed Flash through a 30-step multi-file race-condition investigation. From step 2, v0.15.1 escalates a fast-tier turn to heavy exactly once when the work itself turns out heavy: 8+ in-turn tool calls or 24,000+ cumulative tool-result characters (configurable; disable with `discoveredEscalation: false`). Escalation is one-way — heavy is never downgraded mid-turn — preserving reasoning continuity and cache behavior. The audit's own scenario ("Flash discovers scheduler race → verification fails → still Flash") is covered by an integration test that asserts the flip point lands at the configured bound.

### 5. `request/header` was not enough as routing telemetry (fixed: `model/routing-decision`)

A new log-only, ignorable session event records what the header cannot: turn, step, proposed and selected routes, authority (`router` / `explicit-selection`), reason, score with per-signal counts, threshold, and policy version. Events fire on ownership and route changes (lean default); `recordAllDecisions: true` records every decision for telemetry deployments. The event is registered in the canonical generated vocabulary (`gen-persistence-catalog` regenerated) and designed to plug into outcome verification: correlating `model/routing-decision` with per-tier verified success is the calibration loop the audit proposed.

### 6. Restart semantics were weak (fixed)

Router ownership now reconstructs from the durable decision history after a restart (`reconstructMemory`), so a router-escalated session is correctly re-scored on its next turn instead of being mistaken for an explicit selection. Reconstruction honors policy versions and ignores explicit-authority records. Covered by tests.

### 7. Subagent coordinator hole (fixed)

With `routeSubagents: true`, v0.15.0 still scored only `source.kind === 'user'`, so parent→child coordinator delegations scored zero. `turnUserText` now includes `coordinator`-authored requests (the merge-extensible kind declared by `dsh-subagent`) alongside direct user prompts; plugin injections, child reports, and tool output remain excluded. The runtime check is deliberately string-based so the package compiles against the base vocabulary without depending on `dsh-subagent`.

### 8. English-centric vocabulary (mitigated)

Built-in Simplified Chinese marker families now cover explicit reasoning (一步步, 深入思考, …), formal reasoning (证明, 定理, 推导, …), and system design (架构, 重构, 分布式, 并发, 竞态, …). Any language extends via `extraMarkers` config — plain substrings (CJK has no word boundaries; regexes from config would be a reDoS surface), validated non-empty at resolve time. A Chinese concurrency prompt now scores through vocabulary, not just length.

### 9. Eager per-request work (fixed)

Turn text is now extracted lazily through a facts thunk: passthrough and retention paths never scan the session log; scoring reads text once; discovered-complexity measurement reads once. Covered by a test whose fact getters throw if touched on the wrong path.

### 10. Unverified cloud model ids in the default catalog (fixed)

`deepseek-v4-flash-0731` / `deepseek-v4-pro-0813` are real Hugging Face artifacts, but current official cloud API docs list only the floating ids, so v0.15.1 removes the dated aliases from `DEFAULT_MODELS` (back to the documented three) and documents them as open-weight snapshot identifiers for self-hosted deployments, added explicitly through `models:`. The release guard pins this: unverified cloud aliases may not re-enter defaults.

### 11. SSE idle-timeout completion (the audit's v0.14.2 follow-up)

Buffering headers fixed batching; they did nothing for idle-connection expiry. Both `/api/events.*` channels (via the shared `sseResponse`) and the HMR event channel now emit a `: hb` comment every 15 seconds while idle, cleared on close/cancel. The HMR channel also gains the header regression test v0.14.2 lacked (headers + heartbeat cadence + close cleanup), and the API channels gain a heartbeat test using fake timers against the real stream.

### 12. Loader test ≠ packed consumer (fixed: real packed-consumer gate)

`verify:model-router-packed` builds the package's full runtime peer closure through the repository's own toolchain (`tsc -b` project builds, tsdown bundles for cordis/cosmokit/brand/timeout/scope/session/agent-loop/llm/agent/router), then imports `@deepseek-ai/dsh-llm-model-router` **as a plain Node consumer through the exports map** and exercises the public API: every export, plugin identity, invariant companion shape, and a live v2-policy decision through the built bundle. This is the root-export class of defect the audit flagged from the earlier hardening package.

### 13. No v0.15 release guard in the root chains (fixed)

`verify:model-router-v15` (structural source guard: package shape, authority wiring, calibration-contract export, durable-event registration, cloud-catalog hygiene, SSE liveness, README pairing hashes) and `verify:model-router-packed` are wired into `check:all` and `check:ci`, matching the v0.5–v0.14.x qualification convention.

## Router test coverage added for the audit's edge cases

Explicit Pro immediately after router-owned Pro (both mark and field-rewrite forms); restart reconstruction (router-owned heavy re-scored; explicit-authority and stale-policy records ignored); mid-turn discovered escalation (flip point, one-way, disable); the audit's full calibration prompt table; concise hard coding prompt stays fast; long trivial input at any length; multilingual complex prompts (built-in CJK and configured vocabulary); coordinator-authored child turns; lazy facts; explicit-selection passthrough in both directions with lean event recording.

## Qualification

| Suite | Result |
|---|---:|
| llm-model-router (unit + integration + Loader composition) | 32/32 PASS |
| llm-deepseek (catalog reverted to documented defaults) | 339/339 PASS |
| host/apiproxy (incl. SSE heartbeat + header regressions) | 378/378 PASS |
| client/connection + client/hmr (incl. HMR header/heartbeat) | 117/117 PASS |
| core/agent + agent-default-model (provenance exports) | 92/92 PASS |
| core/agent-loop (request seam regressions) | 335/335 PASS |
| core/agent-tool-presentation | 7/7 PASS |
| llm-retry | 66/66 PASS |
| compaction family | 194/194 PASS |
| **Total targeted executable checks** | **1560/1560 PASS** |

To be read as the audit prescribed: **32 router-specific tests plus broad surrounding regression coverage**, not 1,560 tests of routing policy.

Additional gates: `verify:model-router-v15` PASS; `verify:model-router-packed` PASS (built-bundle consumer import); `gen-persistence-catalog --check` PASS (canonical `model/routing-decision`); `verify-translation-pairing` on both edited README pairs PASS; `check-workspace-constraints` clean for every touched package.

## Pre-existing baseline boundaries (unchanged, now verified pre-existing)

- `packages/core/session/tests/repair.spec.ts` has one deterministic expectation mismatch present in the original v0.14.1 upload (source says "Retry only if…", test expects lowercase); byte-verified against the pristine archive and untouched here.
- The `packages/runtime/*` constraint and compile findings (resource-governor, performance-telemetry, agent-kernel-hardening, outcome-verification) fail identically in the unmodified baseline; the full-workspace `tsc -b tsconfig.host.json` therefore still cannot complete in the clean archive environment. The packed-consumer gate builds the router's own closure instead, which is the honest scope.
- Full dependency-installed upstream pnpm monorepo CI remains not claimed, as in v0.14.1/v0.15.0.

## Remaining boundaries (v0.15.1 scope decisions)

1. **Ambiguous residual in continuity** — an explicit selection byte-identical to the router's own last returned config is indistinguishable from router ownership and may be re-scored next turn; every field-different selection is detected. A selection-side authority field on `LlmCallConfig` would close this and remains deferred as a cross-package contract change.
2. **Discovered-escalation triggers are volume heuristics** — tool-call count and result characters are difficulty proxies, not semantics. The durable decision event is the substrate for calibrating them against verified outcomes; that calibration loop itself is deferred.
3. **Built-in vocabulary is English + Simplified Chinese** — other languages configure `extraMarkers`.
4. **Router remains opt-in composition** — not in the default bundle or Python runtime closure, by design.

## Operational effect

v0.15.1 keeps Flash as the honest default the audit's pricing analysis argued for (no keyword pile, no length padding, no accidental single-family escalation can spend Pro money), gives explicit human selections true precedence over the optimizer in both directions, lets a turn escalate exactly once when the work itself turns out hard, and leaves a durable, analyzable record of every routing decision — the substrate the "verified success per dollar" objective needs.
