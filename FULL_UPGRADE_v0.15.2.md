# DeepSeek Harness FULL Upgrade v0.15.2

## Release objective

v0.15.2 is the routing-correctness-and-authority release responding to the second external audit (the v0.15.1 review). The audit's verdict — "the remaining defects are significantly narrower; the major remaining problem is authority persistence" — sets this release's single objective: **model selection authority must be explicit, durable, restart-safe, and impossible for the router to infer incorrectly.** No new routing algorithm, no new subsystems; every change closes a named audit finding. The event-sourced kernel, governor, and enforcement policy remain intact, and the v0.15.1 policy constants are frozen in `BASELINE_v0.15.1.json` as the comparison baseline (audit Phase 0).

## The audit's findings and their fixes

### 1. Restart authority bug: an explicit-authority record did not terminate older router ownership (HIGH — fixed)

`reconstructMemory()` walked backward *skipping* explicit-authority records until it found a router record, so the exact sequence "router escalates to Pro → operator explicitly selects Pro → restart" resurrected the stale router record and downgraded the operator's choice to Flash on the next simple turn. Reconstruction is now **latest-authority-event-wins**: a `router` record restores router ownership; an `explicit-selection`, `foreign-route`, or `subagent-owner` record ends it. The skipped-record pattern is structurally forbidden by the release guard, and the audit's exact sequence — plus its Flash variant — are integration regressions that drive a real agent loop through a simulated router restart (fiber disposal + fresh mount over the same session log).

### 2. `resolveConfig()` did not enforce the calibration contract (HIGH — fixed)

v0.15.1 exported `noFamilyAloneReaches()` and documented that thresholds at or below a family cap "fail loudly" — but never called it, so `escalationThreshold: 3` was silently accepted and a single keyword family could escalate alone. `resolveConfig()` now rejects any threshold where a family cap reaches it (1–3 against the default caps); thresholds 4, 5, and 9 are boundary-tested both ways. The release guard asserts the call exists, not just the export.

### 3. SDK model selections were not marked explicit (MEDIUM–HIGH — fixed)

Only the web API proxy earned the explicit-selection mark; the JSON-RPC SDK's `initialize(provider, model)` flowed into `agentOptions` unmarked, so a composed router could treat the SDK caller's deliberate choice as router-managed. The SDK server's agent setup now marks the initialize-supplied selection explicit, and a server-suite regression asserts the mark lands on a live session. The CLI/headless path was audited and deliberately left unmarked: it reads the deployment default, not a per-session deliberate choice.

### 4. `recordAllDecisions` did not record all decisions (MEDIUM — fixed)

Subagent passthrough, foreign-route passthrough, and quiet turn-retention bypassed the record path entirely. All three now flow through it: lean mode still records only ownership claims and route changes, while telemetry mode records literally every decision with the right authority (`subagent-owner`, `foreign-route`, `router`). Both directions are tested.

### 5. Explicit marks were process-local and sometimes never durably recorded (MEDIUM — fixed)

A fresh-session explicit selection produced no routing event at all (proposed === selected, no router ownership), so its authority evaporated on restart. The first explicit claim on a session is now recorded durably (`explicit-selection`, epoch 1), reconstruction restores it, and re-records are suppressed while the claim stands. Combined with fix 1, explicit authority is now durable in both the "router-owned first" and "explicit from the start" cases.

### 6. Mid-turn events lacked trigger metrics (MEDIUM — fixed)

`mid-turn-escalated` records now carry `discovered: { toolCalls, toolResultChars, trigger }` with the trigger discriminated as `tool-calls`, `tool-result-volume`, or `composite` — the measurements the audit said future threshold calibration needs. All three triggers are unit-tested.

### 7. `release:verify` omitted the router gates (MEDIUM — fixed)

The v0.15/v0.15.1 guards were wired into `check:all`/`check:ci` but not the release verification chain. `release:verify` now runs `verify:model-router-v15`, `verify:model-router-packed`, and the new `verify:model-router-v152`; the v152 guard asserts all three chains contain all router gates, so release verification cannot silently lag CI again.

### 8. Marker families could fake independence (LOW–MEDIUM — fixed)

A marker duplicated across configured families counted as two "independent" signals. Validation now rejects, after normalization (trim + lowercase + NFC): cross-family duplicates among configured markers, intra-family duplicates, and — beyond the audit's finding — configured markers colliding with any **built-in** vocabulary (same-family double-count or cross-family fake corroboration, e.g. `reasoning: [架构]`). The error names the marker and both families implicated.

### Authority epochs (audit Phases 1–2)

Every recorded decision now carries a strictly increasing per-session `authorityEpoch` — the durable form of "who selected this model, and when" — so a later record always outranks an earlier one. Events written before v0.15.2 carry no epoch and read as 0: their authority meaning survives the upgrade (policy version 2 is retained deliberately for continuity), they simply order below every epoch-stamped record. Reconstruction derives the epoch from the latest record.

### Packed verification strengthened (audit Phase 15)

The fresh build environment exposed that the v0.15.1 packed script silently depended on leftover `lib/` artifacts (vendor/schemastery was never bundled by the script itself). It now builds the complete closure from a clean tree — including the dual-format schemastery build — and adds a real `npm pack` step: the tarball is extracted into an isolated consumer directory (published files only, peers linked), imported **by name** through the exports map, and exercised — including asserting that threshold enforcement is present in the published artifact. The isolated consumer imports only the declared public API, never source paths.

## Definition of Done: the audit's 18 scenarios

| # | Scenario | Where proven |
|---|---|---|
| 1 | simple task → Flash | integration: simple turn stays fast |
| 2 | complex cross-family task → Pro | integration: corroborated escalation |
| 3 | long trivial prompt → Flash | unit: length cap alone stays below threshold |
| 4 | Chinese complex prompt → Pro | unit: CJK corroboration escalates |
| 5 | explicit Pro → retained | unit: explicit mark owns both directions |
| 6 | router Pro → explicit Pro → restart → still explicit Pro | integration: DoD 6 restart test |
| 7 | router Pro → explicit Flash → restart → still explicit Flash | integration: DoD 7 restart test |
| 8 | custom threshold 3 → rejected | unit: threshold enforcement |
| 9 | overlapping marker configuration → rejected | unit: marker independence |
| 10 | concise hard task → starts Flash | integration: race-condition prompt |
| 11 | tool evidence → one-way Pro escalation | integration: tool-loop flip point |
| 12 | coordinator child message → scored when enabled | unit: coordinator requests score |
| 13 | foreign model → untouched | integration: foreign model passthrough |
| 14 | SDK-selected model → explicit authority | SDK server suite: mark lands on live session |
| 15 | recordAllDecisions → every route branch durable | unit: telemetry truthfulness |
| 16 | package tarball → clean consumer imports | packed gate: npm pack + isolated consumer |
| 17 | release:verify → includes routing guards | v152 guard check #7 |
| 18 | process restart → routing authority deterministic | DoD 6/7 + reconstruction unit tests |

## Qualification

| Suite | Result |
|---|---:|
| llm-model-router (unit + restart integration + Loader composition) | 44/44 PASS |
| sdk/server (incl. explicit-authority regression) | 33/33 PASS |
| host/apiproxy (SSE headers/heartbeat regressions) | 378/378 PASS |
| client/connection + client/hmr | 117/117 PASS |
| core/agent + agent-default-model (provenance exports) | 92/92 PASS |
| core/agent-loop (request seam regressions) | 335/335 PASS |
| core/agent-tool-presentation | 7/7 PASS |
| llm-deepseek | 339/339 PASS |
| llm-retry | 66/66 PASS |
| compaction family | 194/194 PASS |
| **Total targeted executable checks** | **1605/1605 PASS** |

Read as the audits prescribed: **44 router-specific tests plus broad surrounding regression coverage**, not 1,605 tests of routing policy.

Additional gates: `verify:model-router-v15` PASS; `verify:model-router-v152` PASS (all ten structural checks, each mapping to a shipped defect); `verify:model-router-packed` PASS (clean-tree closure build + npm pack + isolated consumer); `gen-persistence-catalog --check` PASS (regenerated for the epoch/discovered payload); `verify-translation-pairing` on the router README pair PASS; `check-workspace-constraints` clean for every touched package.

## Pre-existing baseline boundaries (unchanged from v0.15.1, verified against the pristine v0.14.1 upload)

- `packages/core/session/tests/repair.spec.ts`: one deterministic expectation mismatch present in the original archive.
- `packages/runtime/*` compile/constraint failures identical in the unmodified baseline; the full-workspace `tsc -b tsconfig.host.json` still cannot complete in the clean archive environment. The packed gate scopes to the router's own closure, which now builds from a genuinely clean tree.
- Full dependency-installed upstream pnpm monorepo CI remains not claimed.

## Remaining boundaries (deliberate v0.15.2 scope decisions)

1. **Selection-side authority field on `LlmCallConfig`** — the audit's full first-class `AuthorizedModelSelection` contract remains deferred; v0.15.2 closes every *demonstrated* mis-inference with durable events + epochs + latest-record-wins reconstruction instead. The event stream is now authoritative for authority; the WeakMap mark is a live cache.
2. **Discovered-escalation triggers remain volume heuristics** — verification failures, repair rounds, tool errors, and reasoning-context pressure are the audit's proposed stronger signals; they belong to v0.16's empirical release, which the `discovered` telemetry now feeds.
3. **Router remains opt-in composition** — not in the default bundle or Python runtime closure; with authority now durable, that posture is the audit's stated preference until the empirical loop proves routing value.
4. **Runtime-corpus metrics are not claimed** — routing distribution, false-escalation rates, and cost/latency per tier require the v0.16 harness; the frozen baseline records only deterministic policy constants and shipped test counts.

## Operational effect

Routing authority is now a durable, auditable fact: every claim, transition, and escalation is a session event with an epoch; explicit human or SDK choices outrank the optimizer before and after restarts; the calibration contract and vocabulary independence fail loudly at load instead of silently degrading; and the release chain itself refuses to ship if any of these invariants regress. The substrate for v0.16's empirical optimization — decision → cost → latency → verified outcome — is complete.
