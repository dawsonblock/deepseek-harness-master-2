# DeepSeek Harness FULL Upgrade v0.15.4

## Release objective

v0.15.4 is the control-plane correctness release responding to the fourth external audit (the deep v0.15.3 second-pass review). The audit's central finding: v0.15.3 made selection OWNERSHIP durable but not the complete selection STATE — fragmented across a durable authority event, a process-local WeakMap, a picked model, and the request header, producing failure modes around restart, crash recovery, and returning to Auto. This release consolidates the control plane into ONE durable `ModelSelectionState`, makes every semantic change durable, fixes Auto after real process restarts, exposes Auto through the production API, restores decision purity, completes the telemetry substrate, and adds the runtime invariant layer the audit asked for. No routing-heuristic changes; the audit's directive ("fix the control plane, then go measure") is followed exactly. The event-sourced kernel, governor, and enforcement policy remain intact.

## The audit's findings and their fixes

### 1. Auto was broken after a real process restart (Finding 1 — fixed, release-blocking)

`clearExplicitModelSelection` gated on the process-local WeakMap: after a restart the map was empty, so selecting Auto returned immediately and never appended the `router` authority event — durable reconstruction kept honoring the manual claim forever. `releaseToAuto` now derives the current state from the DURABLE event log (`reconstructSelectionState`), releasing whenever a manual state is latest, WeakMap or not. The regression test performs a TRUE process restart — `Session.create(id, persistedEvents, header)` on a fresh Session object with every live reference dropped — exactly the failure model the audit said the v0.15.3 test (router-plugin dispose/reload on the same Session) did not cover.

### 2. Auto did not clear the actual selected model (Finding 2 — fixed through the production API)

Releasing authority left the picked (possibly foreign) model impersonating a manual choice. `session.selectModel` now accepts the discriminated `{ mode: 'auto' }` payload (RPC type + wire schema + handler): it releases durable manual authority AND resets the effective selection to the deployment default through a **non-claiming reset** (`resetAutomatic` — the claiming setter would immediately re-claim manual authority). A manual foreign model followed by Auto now yields the default route, not a lingering passthrough.

### 3. Manual selections were not crash-durable (Finding 3 — fixed)

The authority event carried provider/model, but the API proxy's selection getter fell back to the LOGGED REQUEST HEADER before consulting it — so "user selects Pro; crash before any request; restart" honored the user's authority while restoring the header's Flash. The getter now consults the durable manual state (with its complete selection, reasoning effort included) BEFORE the header; the fresh-context test proves a new proxy over the same log resolves the claimed model.

### 4. Same-authority reselection silently lost durable changes (Finding 4 — fixed)

Event suppression compared authority identity alone, so user/Pro → user/Flash recorded nothing and a crash restored Pro. Suppression now compares the COMPLETE semantic state (mode, authority, provider, model, reasoningEffort, source): only a true no-op is skipped; the Pro→Flash switch and web→api provenance changes are durable transitions. Regression-tested with a crash between the switch and any request.

### 5. The state abstraction was fragmented (Finding 5 — replaced)

`ModelSelectionState` is now one durable union: `{ mode: 'auto', authority: 'router'|'default', epoch, source }` or `{ mode: 'manual', authority: user|sdk|policy|subagent-owner, selection: { provider, model, reasoningEffort? }, epoch, source }`. The event carries it whole; the WeakMap is explicitly a cache; epochs never reset (`nextAuthorityEpoch` still continues above every persisted epoch across schema versions and the legacy carrier).

### 6. `default` was a zombie state (Finding 6 — fixed)

Reconstruction handles `default` exhaustively as a real automatic state; it no longer falls through while older history could win. The invariant companion rejects states outside their mode's vocabulary (manual authorities on auto states and vice versa fail closed).

### 7. Future authority schemas were too permissive (Finding 7 — fail-closed)

A schema-version NEWER than the runtime's no longer gets skipped (which could resurrect a superseded older claim after a downgrade): `reconstructSelectionState` returns an `undecidable` state and the router DEFERS. Legacy v0.15.3 schema-1 events map to the new model (manual over their provider/model; router/default → auto).

### 8. Provenance could misclassify authority (Finding 8 — fixed)

`claimModelSelection` takes the authority explicitly and validates the authority/source combination against an allowlist (web→user; sdk→sdk; api/cli→user|policy; subagent→subagent-owner; system→policy|default|router; router→router|default). `markExplicitModelSelection` remains the compat entry point but now REQUIRES a complete route — a manual claim without provider/model throws — closing the audit's "manual selection must contain a model" invariant at the write boundary.

### 9. `decideRoute` was not pure (Finding 9 — deterministic identity)

`routingDecisionId` was `randomUUID()` inside the policy function. It is now derived — `sha256(sessionId : turn : step : policyVersion : configFingerprint)` — via the exported `routingDecisionIdentity`: same execution coordinates reproduce the same id under replay, and the policy path contains no identity generation. Tested for coordinate stability and per-turn distinctness.

### 10. `SCORER_VERSION` was dead metadata; configuration drift was untracked (Findings 10–11 — stamped)

Every durable decision now carries `scorerVersion` (from the scorer module) and `configFingerprint` — a canonical SHA-256 over the effective configuration (threshold, routes, markers, discovered bounds, subagent policy, telemetry mode). Two deployments sharing POLICY_VERSION but configuring different markers can no longer contaminate an experimental dataset indistinguishably. The invariant companion enforces the stamps' presence.

### 11. routingDecisionId was not a join key (Finding 12 — documented coordinates)

The id is now deterministic FROM the canonical execution coordinates (session, turn, step) + policy + config, so it joins any event family that carries those coordinates while remaining a stable identity in its own right. Propagation into model/usage events remains v0.16 join work; the substrate is complete.

### 12. The invariant companion was empty (Finding 15 — implemented)

`./invariant` now polices the control plane at runtime, for loaded sessions and freshly appended events: authority epochs never regress; manual states carry complete non-empty selections and auto states carry none; a router-owned decision never supersedes manual authority without an intervening Auto release (the audit's central rule); every decision carries its deterministic id, scorer version, and configuration fingerprint; future-schema states are rejected rather than skipped. Eight companion tests cover each rule and its healthy counterpart.

## Audit adversarial battery (item 9) — proven

| Scenario | Where proven |
|---|---|
| full process reconstruction → Auto | router suite: fresh-Session restart → `releaseToAuto` appends the auto event and the router honors it |
| selectModel(Pro) → crash before prompt → restart | router suite (durable state restores selection+authority) AND apiproxy suite (fresh-context proxy resolves the reasoner over the stale header) |
| Pro → Flash same authority → crash | router suite: two durable transitions; reconstruction restores Flash |
| manual foreign-model → Auto | apiproxy suite: mode auto resets to the default route; router suite: reconstruction yields router authority |
| Auto with no router composed | apiproxy suite: Auto resets the effective selection to the deployment default (selection resolution needs no router) |
| valid `default` state | router suite: `default` reconstructs as automatic; invariant rejects vocabulary violations |
| future authority schema | router suite + invariant suite: fail-closed defer; rejected at append |
| replayed route decision identity | router suite: coordinate-derived ids are reproducible and turn-distinct |

## Qualification

| Suite | Result |
|---|---:|
| llm-model-router (unit + restart/Auto/SDK/purity battery + 8 invariants + Loader composition) | 62/62 PASS |
| core/agent (incl. authority suite: claims, semantic transitions, Auto, epochs) | 92/92 PASS |
| core/agent-default-model | 5/5 PASS |
| core/agent-loop | 335/335 PASS |
| core/agent-tool-presentation | 7/7 PASS |
| host/apiproxy (incl. Auto API + crash-durability regressions) | 380/380 PASS |
| client/connection + client/hmr | 117/117 PASS |
| llm-deepseek | 339/339 PASS |
| llm-retry | 66/66 PASS |
| compaction family | 194/194 PASS |
| sdk/server | 33/33 PASS |
| **Total targeted executable checks** | **1630/1630 PASS** |

(62 router-package tests — including the new invariant suite — plus broad surrounding regression coverage.)

Additional gates: `verify:model-router-v15`, `-v152`, `-v153`, `-v154` PASS (each defect check tracked to its v0.15.4 location; v154 pins the state model, the deterministic identity, the stamps, the invariant companion, the API Auto shape, the fail-closed reconstruction, the shared-chunk packaging, and the chain membership); `verify:model-router-packed` PASS (clean-tree closure build, version assertion on the built tarball, isolated consumer; the package now declares its shared runtime chunk `lib/types-*.js` in `files`, with the workspace constraint extras taught accordingly); `gen-persistence-catalog --check` PASS; `verify-translation-pairing` PASS; `check-workspace-constraints` reports no findings for any touched package.

Release hygiene: the root manifest and all 231 release members bump `0.1.1-rc.3` → `0.1.1-rc.4`, so no build shares an immutable package identity with another.

## Pre-existing baseline boundaries (unchanged from v0.15.3, verified against the pristine v0.14.1 upload)

- `packages/core/session/tests/repair.spec.ts`: one deterministic expectation mismatch present in the original archive.
- `packages/runtime/*` compile/constraint findings identical in the unmodified baseline; the full-workspace `tsc -b tsconfig.host.json` still cannot complete in the clean archive environment.

## Remaining boundaries (deliberate v0.15.4 scope decisions)

1. **routingDecisionId propagation into model/usage events** — the deterministic id joins by execution coordinates today; carrying it through `model/request`/usage/outcome receipts belongs to v0.16's join work.
2. **Structural workload signals** — the audit's finding that keyword scoring misses semantically hard prompts ("do a deep extraction and analysis" → 0) is accepted as the v0.16 motive: the measurement release replaces hand-tuned heuristics with verified-outcome-driven calibration, not more vocabulary.
3. **Router remains opt-in composition** — unchanged until the empirical loop proves routing value.
4. **recordAllDecisions stays false in production** — per the audit: log volume wins by default; controlled evaluation runs enable it.

## Operational effect

The control plane is now one provable object per session: claims carry their complete selection, every semantic change is durable, Auto is a first-class API state that survives real restarts and clears stale routes, reconstruction is exhaustive and fails closed on the unknown, decisions are pure and self-describing (scorer + configuration), and a runtime invariant layer polices all of it. The audit's stated next milestone — v0.16: join routing decisions to model usage and Outcome Verification and find out whether Flash/Pro routing improves verified quality per dollar and per second — has its complete substrate.
