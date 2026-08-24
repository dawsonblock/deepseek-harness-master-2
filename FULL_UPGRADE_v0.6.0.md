# DeepSeek Harness Full Verified-Commit & Chaos Qualification Upgrade v0.6.0

v0.6.0 tightens the v0.5 autonomy safeguards instead of adding another orchestration layer. The production TypeScript Harness remains the sole execution authority; the Python kernel remains a reference/test oracle.

## 1. One-shot verified completion commit

v0.5 verified an autonomous goal and then called the ordinary `complete()` transition. v0.6 closes that verification-to-commit gap.

`GoalService.completeVerified(agent, ref)` now requires the immediately preceding durable session event to be a **passing** `goal/verification` for the exact goal id and revision being completed. Any intervening durable event invalidates the authorization and forces verification to run again.

This gives the goal transition a one-shot evidence token encoded directly in the append-only session log:

```text
verifyCompletion(goal revision N)
        |
        v
goal/verification { passed: true, revision: N }
        |
        | no event may intervene
        v
completeVerified(goal revision N)
        |
        v
goal/change -> complete
```

Rejected cases include:

- no verification event;
- failed verification;
- verification for another goal;
- verification for an older/newer revision;
- any durable event appended after verification.

`tool-goal` uses `completeVerified()` for independently-verified autonomous goal rounds. Direct human authority continues to use the ordinary explicit completion path.

## 2. Acceptance vs integrity verifier roles

The verifier registry now distinguishes two semantics:

- `registerAcceptanceVerifier(...)` — objective-specific evidence authority that can prove the requested work is complete;
- `registerIntegrityVerifier(...)` — supplemental runtime/safety constraints that can reject completion but cannot by itself prove objective success.

The existing `registerCompletionVerifier(...)` remains as a backward-compatible alias for `registerAcceptanceVerifier(...)`.

The runtime-owned `runtime-integrity` verifier is explicitly tagged as an integrity verifier. Autonomous completion still fails closed unless at least one acceptance verifier is installed and every acceptance/integrity check passes.

This corrects an ambiguity in v0.5 where every caller-registered verifier was implicitly treated as objective acceptance evidence.

## 3. Expanded native recovery classification

The following additional first-party read-only tools now explicitly declare `recovery: { mode: 'idempotent' }`:

- `web_fetch`;
- `web_search`;
- `lsp`;
- `session_search`;
- `session_event_search`;
- `session_trace`;
- `session_event_trace`;
- `session_event_read`.

They join the v0.5 coverage for filesystem `read`, `read_image`, `grep`, and `glob`.

This matters after `tool/dispatch` has been recorded but no durable result exists: read-only operations can safely retry instead of being blocked as side-effect-ambiguous.

Arbitrary shell, terminal, workflow mutation, user-interaction, scheduling, and other side-effect-capable tools are **not** automatically marked idempotent. v0.6 deliberately fails closed rather than making an unsafe blanket classification.

## 4. Reconciliation semantics remain enforced before redispatch

The v0.5 native recovery contract remains authoritative:

- `completed` -> reconstruct the prior canonical value, no body redispatch;
- `not-executed` -> body dispatch is permitted;
- `unknown` -> fail closed with reconciliation required.

The full-file filesystem `write` reconciler remains a concrete first-party implementation: it proves prior completion only when current file contents exactly equal the intended full write.

## 5. Failure-injection qualification

v0.6 adds a dependency-free failure-injection specification at:

`./scripts/qualification-agent-kernel-v06.mjs`

It exercises the critical recovery and completion-state cases without requiring the pnpm workspace dependency graph:

1. crash before `tool/dispatch` -> `not-started`;
2. crash after `tool/dispatch` -> `outcome-unknown`;
3. durable result -> completed;
4. legacy unmatched tool call -> conservative `outcome-unknown`;
5. fresh passing goal verification -> commit allowed;
6. failed goal verification -> blocked;
7. an intervening durable event -> verification authorization invalidated;
8. stale goal revision -> blocked;
9. wrong goal id -> blocked;
10. reconciliation `completed` -> reuse result, no redispatch;
11. reconciliation `not-executed` -> dispatch allowed;
12. reconciliation `unknown` -> block.

The source-integration guard at `scripts/verify-agent-kernel-v06.mjs` verifies that the production wiring remains present, including:

- explicit acceptance/integrity verifier APIs;
- fresh-verification requirement;
- verifier-before-verified-commit ordering in `tool-goal`;
- reconciliation preflight;
- dispatch lifecycle evidence;
- filesystem write reconciliation;
- explicit idempotent recovery on the newly covered read-only tools.

Both checks are included in root `check:all`, `check:ci`, and `release:verify` chains.

## 6. Regression fixtures

Native goal tests now include fixtures for:

- integrity-only verifier registration failing to satisfy the objective acceptance requirement;
- successful `completeVerified()` immediately after exact passing verification;
- invalidation when any durable event intervenes between verification and completion.

These fixtures are shipped for the normal dependency-backed Vitest workspace run.

## 7. Hardening package

`@deepseek-ai/dsh-agent-kernel-hardening` is bumped to `0.4.0` and documents the verified-commit semantics and expanded idempotent coverage. It remains an observer/analyzer of the canonical TypeScript runtime rather than a parallel execution engine.

## 8. Validation performed in this archive environment

Executed successfully in this build environment:

- Python reference kernel: **12/12 pytest tests passed**;
- Python `compileall`: **PASS**;
- v0.6 source integration guard: **PASS**;
- v0.6 failure-injection specification: **12/12 PASS**;
- TypeScript syntax transpilation on all eight modified native TypeScript source/test files: **8/8 PASS**.

A targeted TypeScript project-reference build was attempted. It is blocked before dependency-backed semantic typechecking because the clean extracted archive does not contain the installed `@types/node` / pnpm workspace dependency graph. Therefore this release does **not** claim a full upstream workspace CI pass.

## 9. Architectural result

The production completion path is now:

```text
worker requests completion
        |
        v
independent acceptance + integrity verifiers
        |
        v
durable goal/verification
        |
        | exact revision + no intervening event
        v
completeVerified()
        |
        v
durable goal/change -> complete
```

The recovery path remains:

```text
tool/call
   |
tool/dispatch
   |
crash / missing result
   |
   +-- idempotent ----------> safe retry
   |
   +-- reconcile -----------> completed / not-executed / unknown
   |                              |           |            |
   |                              v           v            v
   |                          reuse result   retry        BLOCK
   |
   +-- unclassified side effect -> BLOCK / require operator or domain reconciler
```

## 10. Remaining high-value work

The next upgrades should be evidence-driven, not more agent count:

1. dependency-backed full monorepo CI and execution of the shipped native regression tests;
2. real process-kill chaos tests around dispatch, settle, persistence flush, and compaction boundaries;
3. domain reconcilers for additional first-party side-effecting tools where external state can be proven;
4. deployment-specific acceptance verifiers for tests, artifacts, benchmark thresholds, and external-state assertions;
5. paired task-level experiments measuring whether strict verification/reconciliation improve successful-task reliability per unit cost and latency.
