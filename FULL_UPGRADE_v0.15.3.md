# DeepSeek Harness FULL Upgrade v0.15.3

## Release objective

v0.15.3 is the Routing Authority & Release Hygiene release responding to the third external audit (the v0.15.2 review). The audit's verdict — "v0.15.2 is the strongest router release so far… the remaining question is authority persistence and release identity" — sets this release's scope: **model-selection authority must be durable, version-independent, reversible, and unambiguous across restarts and future router policy upgrades.** No new routing heuristics, no new subsystems; the audit's closing instruction ("stop after v0.15.3 — move to measurement") is the stated plan for v0.16. The event-sourced kernel, governor, and enforcement policy remain intact.

## The audit's findings and their fixes

### 1. Package version did not change between releases (MEDIUM-HIGH — fixed)

v0.15.1 and v0.15.2 shipped materially different router code under the same package identity `0.1.1-rc.2` — an immutable-registry hazard, enshrined by the release guards themselves. Fixed as a **release-wide version bump**: the root manifest and all 231 release members carrying `0.1.1-rc.2` move to `0.1.1-rc.3` (the repository's workspace constraint requires every `@deepseek-ai/dsh-*` release member to match the root version, so the identity fix is a release action, not a router-only edit; vendor packages keep their upstream versions per the existing exemption, and the runtime-hardening family's independent versions are untouched). The guards now assert `0.1.1-rc.3`, and the packed-consumer gate asserts the version on the **built artifact** — the published tarball can no longer share identity with the v0.15.1/v0.15.2 builds.

### 2. Authority was coupled to router policy version (MEDIUM-HIGH — fixed)

`reconstructMemory` filtered EVERY durable record by `POLICY_VERSION`, so a future router policy bump (v2→v3) would silently erase a user's recorded explicit choice. v0.15.3 splits the two concepts the audit said were intertwined:

- **`model/selection-authority`** — a new durable session event, declared in `@deepseek-ai/dsh-agent` (always composed; NOT the opt-in router), carrying `authority` (`default`/`router`/`user`/`sdk`/`policy`/`subagent-owner`), `source` (`web`/`sdk`/…), `authorityEpoch`, and its own `authoritySchemaVersion: 1` — **never a router policy version**. A recorded human or SDK choice survives any router upgrade unless a newer authority event supersedes it.
- **`model/routing-decision`** — remains the routing-analysis stream and gains `routingDecisionId` (a per-decision correlation id for the v0.16 outcome/cost joins) and `activeAuthority` (the session authority in force at the decision); its legacy `authorityEpoch` field is now read-only (v0.15.2 compatibility) and the epoch lives on the authority event.
- **Reconstruction is latest-deciding-record-wins with policy asymmetry**: authority events decide at any schema version; legacy explicit/foreign/subagent barriers decide at ANY router policy version (the audit's exact requirement); only router-owned route continuity is policy-version filtered — a stale router era can never resurrect, and a stale explicit barrier can never be forgotten. Both directions are regression-tested, including the audit's future-policy scenario (explicit barrier written by "policy v1" honored by policy v2).

### 3. Explicit authority was sticky — no "return to Auto" (MEDIUM — fixed)

Once marked, a session stayed explicit forever (no `clearExplicitModelSelection` existed anywhere). v0.15.3 makes **Auto a first-class operator state**: `clearExplicitModelSelection` in `@deepseek-ai/dsh-agent` clears the live mark and appends a durable `router` authority event, so a manually selected session returns to router management without a new session — and the release survives restarts. The router's in-process cache re-derives from the durable stream when the live mark disappears, and a leftover heavy header from the explicit era re-scores under automatic authority instead of being "retained". The full transition chain — router Pro → explicit Pro → Auto → router re-scores to Flash, then re-escalates on complexity, then survives a restart — is one integration test.

### 4. First foreign/subagent claims were not durable in lean mode (LOW-MEDIUM — fixed, plus docs tightened)

The README overstated "every ownership claim appends a routing decision": subagent and foreign passthroughs recorded nothing in lean mode. Now: **authority events are always durable** (written by the selection surfaces themselves, unconditionally — never gated by router config or `recordAllDecisions`), and passthroughs that **end prior router ownership** record the transition even in lean mode. Sustained passthrough sessions (nothing transitioned) still record nothing in lean mode — the docs now state exactly that. The audit's scenario table:

| Scenario | v0.15.2 | v0.15.3 |
|---|---|---|
| explicit selection claim | durable (routing record) | durable (authority event, unconditional) |
| Auto release | impossible | durable (authority event) |
| foreign/subagent ending router ownership | not recorded (lean) | recorded (lean and telemetry) |
| sustained foreign/subagent passthrough | not recorded (lean) | not recorded (lean); telemetry records all |

### 5. Epochs could reset across policy migrations (fixed)

`authorityEpoch` lived on routing decisions and restarted at 1 whenever reconstruction found no current-policy memory. v0.15.3's `nextAuthorityEpoch` continues above **every** epoch ever persisted — across authority events of all schema versions and the legacy routing-decision carrier — so no restart, policy migration, or schema change ever reuses an epoch. A test drives a v0.15.2 log at epoch 27 to the next claim at 28, and a future-schema event at 99 to 100 (epochs count across schema versions because reusing one could collide when that schema becomes current).

### 6. Selection surfaces lacked provenance labels (fixed)

`markExplicitModelSelection` now records which surface made the claim: the web picker (`source: 'web'`, authority `user`), the SDK initialize path (`source: 'sdk'`, authority `sdk` — the SDK-server regression asserts the label on a live session), with `api`/`cli`/`system` sources available for future surfaces. Same-authority re-selections update the live mark without spamming the event stream; a different authority records the transition.

### 7. Release-gate coverage (per the audit's Phase 14)

`verify:model-router-v153` (source guard: version identity, authority-event existence/canonicality/policy-independence, Auto operation, surface provenance, legacy migration, chain membership, frozen baselines, README pairing) and `qualify:model-router-authority-v153` (executable: the full router suite + the dsh-agent authority suite + the SDK server suite) are wired into **all three** root chains — `check:all`, `check:ci`, `release:verify` — alongside the existing v15/v152/packed gates. Every guard check that a previous defect motivated is retained at its new v0.15.3 location.

## Authority test coverage (the audit's 12-scenario plan)

| # | Scenario | Where proven |
|---|---|---|
| 1–2 | Auto + simple → Flash; Auto + complex → Pro | integration: per-turn re-routing |
| 3–4 | User Pro never downgraded; User Flash never upgraded | integration: explicit mark owns both directions |
| 5–6 | router→explicit (Pro/Flash) → restart → still explicit | integration: DoD 6/7 restart tests (retained from v0.15.2) |
| 7–8 | explicit under policy v2 → read by "policy v3" → still explicit | unit: policy-version independence (stale-policy barriers honored) |
| 9 | User Pro → Auto → router owns next turn | integration: v0.15.3 Auto test (full chain + restart) |
| 10 | SDK Pro → restart → SDK authority remains | integration: sdk authority survives restart |
| 11 | Foreign model → passthrough | integration + unit: foreign passthrough (now recording ownership-end transitions) |
| 12 | subagent-owner route → correct authority | unit: subagent barriers in reconstruction + passthrough attribution |

Configuration tests (threshold 1–3 rejected / ≥4 accepted; cross-family and Unicode-normalized marker collisions rejected) and migration tests (legacy v0.15.1- and v0.15.2-shaped sessions project correctly) carry over from v0.15.2 and remain green; telemetry tests now also prove authority durability with `recordAllDecisions: false`.

## Qualification

| Suite | Result |
|---|---:|
| llm-model-router (unit + restart/Auto/SDK integration + Loader composition) | 48/48 PASS |
| core/agent (incl. new authority suite: mark/clear/Auto, epoch monotonicity) | 92/92 PASS |
| core/agent-default-model | 5/5 PASS |
| core/agent-loop | 335/335 PASS |
| core/agent-tool-presentation | 7/7 PASS |
| sdk/server (explicit-authority regression with source label) | 33/33 PASS |
| host/apiproxy (incl. surface-range test hardened for non-surface authority events) | 378/378 PASS |
| client/connection + client/hmr | 117/117 PASS |
| llm-deepseek | 339/339 PASS |
| llm-retry | 66/66 PASS |
| compaction family | 194/194 PASS |
| **Total targeted executable checks** | **1614/1614 PASS** |

Read as the audits prescribed: **48 router-specific tests plus broad surrounding regression coverage.**

Additional gates: `verify:model-router-v15` PASS; `verify:model-router-v152` PASS (defect checks tracked to their v0.15.3 locations); `verify:model-router-v153` PASS; `verify:model-router-packed` PASS (clean-tree closure build + version assertion + `npm pack` + isolated tarball consumer); `gen-persistence-catalog --check` PASS (regenerated for `model/selection-authority`); `verify-translation-pairing` PASS; `check-workspace-constraints` clean for every touched package (no new findings; the pre-existing runtime-family findings are unchanged).

## Pre-existing baseline boundaries (unchanged from v0.15.2, verified against the pristine v0.14.1 upload)

- `packages/core/session/tests/repair.spec.ts`: one deterministic expectation mismatch present in the original archive.
- `packages/runtime/*` compile/constraint findings identical in the unmodified baseline; the full-workspace `tsc -b tsconfig.host.json` still cannot complete in the clean archive environment. The packed gate scopes to the router's own closure, built from a clean tree.

## Remaining boundaries (deliberate v0.15.3 scope decisions)

1. **First-class `AuthorizedModelSelection` on `LlmCallConfig`** — still deferred; the authority event stream now IS the durable authority record (policy-independent, epoch-monotonic, reversible), which closes every demonstrated mis-inference. A selection-object API remains the cleaner long-term shape before the router becomes a default runtime component.
2. **Web picker Auto button** — the Auto operation ships at the library/API surface (`clearExplicitModelSelection`); the frontend's three-state selector (Auto/Flash/Pro) is Control Center work.
3. **Discovered-escalation triggers remain volume heuristics** — verification failures, repair rounds, tool errors, and reasoning-context pressure are v0.16 signals; `routingDecisionId` and the `discovered` payload are the join keys that release needs.
4. **Router remains opt-in composition** — not in the default bundle; per the audit, that posture holds until the empirical loop proves routing value.

## Operational effect

Release identity is unique per build (`0.1.1-rc.3` across all release members); selection authority is a durable, auditable, policy-independent fact with a monotonic epoch and a first-class return path to automatic routing; the audit's stated next step — v0.16 empirical optimization over Flash-only / Pro-only / Router on real tasks judged by Outcome Verification — now has the complete substrate: authority stream, decision stream with correlation ids, discovered-complexity telemetry, and per-decision authority attribution.
