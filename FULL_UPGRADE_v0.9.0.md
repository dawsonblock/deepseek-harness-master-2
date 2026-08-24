# DeepSeek Harness Full Outcome Verification Engine Upgrade v0.9.0

v0.9.0 builds on v0.8 durable checkpoints/recovery. It does not add another
agent swarm or memory layer. It upgrades the meaning of autonomous completion:
a goal can now be backed by a machine-readable Acceptance Contract, immutable
evidence, version-bound verifier policy, stale-evidence invalidation, a repair
plan, and an Outcome Receipt whose SHA-256 binds the exact proof object.

## 1. New native outcome-verification package

`@deepseek-ai/dsh-outcome-verification` is a dependency-light TypeScript
workspace package with a clean public package entrypoint and packed-consumer
qualification. The package provides:

- Acceptance Contract schema and validation;
- dependency-cycle rejection and stable contract hashing;
- versioned Verifier Registry and policy fingerprint;
- immutable Evidence Store plus append-only invalidation log;
- incremental `verifyStale()` re-verification;
- evidence support/contradiction graph;
- deterministic repair plans;
- Outcome Receipt creation, lineage and tamper checks;
- artifact-hash comparison when validating a receipt against current outputs;
- candidate -> verifying -> verified -> committed-complete state machine;
- verification telemetry;
- coding/runtime acceptance packs;
- structural adapter for the existing GoalService completion gate.

The package includes a dependency-free SHA-256 implementation so the core
proof format does not require Node-only crypto imports.

## 2. Acceptance Contracts

A contract binds one exact goal id/revision to explicit criteria. Each criterion
has a stable id, severity, verification mode, verifier id/version, optional
arguments, dependency edges, timeout, and authority.

Required criteria fail closed. A contract must contain at least one required
criterion before it can pass. Criterion dependency cycles are rejected.

The contract compiler currently supports deterministic `coding`, `runtime`,
and `custom` drafts. It deliberately does not let the worker silently weaken
human/system criteria; `canWorkerMutateCriterion()` only permits criteria whose
explicit authority is `worker`.

## 3. Versioned verifier policy

Every verifier declares:

- stable id;
- semantic version/policy version;
- category: acceptance, integrity, or quality;
- deterministic/non-deterministic flag.

The registry fingerprint is SHA-256 over those properties. Required criteria
can require deterministic verifiers. Integrity-category failures block the
contract even when a criterion was mistakenly marked advisory.

Built-in verifier primitives include:

- `value.equals`;
- `number.minimum`;
- `number.maximum`;
- `benchmark.no-regression`;
- `artifact.sha256`;
- `runtime.no-unresolved-side-effects`.

`createTrustedNamedCheckVerifier()` additionally exposes deployment-owned gates
such as tests/typecheck/build/security checks without turning the acceptance
contract into an unrestricted shell-command surface.

## 4. Immutable evidence and invalidation

Every verifier run appends an immutable evidence record containing:

- criterion id;
- verifier id/version;
- source type and source event sequences;
- observation time;
- result and result hash;
- dependency versions;
- pass/fail reason;
- repair hints.

Evidence is never edited in place. State changes append invalidation records.
A previously passing criterion becomes `STALE` when a dependency is invalidated.
Required stale evidence fails completion by default.

`verifyStale()` reuses still-fresh passing evidence and reruns only invalidated,
missing or failing criteria, preserving the evidence-driven model without
forcing every deterministic check to execute on every loop.

## 5. Evidence graph and contradictions

The engine includes an explicit evidence graph with `supports`, `contradicts`,
`depends-on`, and `invalidates` edges. Contradictions remain explicit data
rather than being averaged away. This is groundwork for stronger research and
multi-source acceptance policies.

## 6. Structured repair plans

A failing verification report can be converted into a Repair Plan listing all
failed, stale, unknown and dependency-blocked criteria plus verifier-provided
repair hints. This turns verifier failure into deterministic next-work input
instead of a generic `FAIL` string.

## 7. Outcome Receipts

A passing report can produce an immutable Outcome Receipt binding:

- exact goal id/revision;
- Acceptance Contract hash;
- verifier-policy fingerprint;
- verification time;
- per-criterion state and evidence hashes;
- artifact SHA-256 records;
- unresolved warnings;
- optional prior-receipt lineage;
- final receipt SHA-256.

A failing report cannot create a receipt. Receipt tampering changes the hash.
When current artifacts are supplied to `verifyReceipt()`, changed artifact
hashes invalidate the current receipt match even when the historical receipt
itself is internally intact.

## 8. GoalService integration

The goal package now exports `registerOutcomeContract()`.

The ordering is:

```text
OutcomeVerificationEngine
        |
        v
Acceptance Contract PASS
        |
        v
goal/outcome-receipt       (log-only immutable proof)
        |
        v
goal/verification          (existing policy-bound authorization)
        |
        v
completeVerified()         (existing one-shot final commit)
```

This preserves the strong v0.6-v0.8 completion invariant. The new engine does
not bypass or replace `completeVerified()`.

A failed contract emits no Outcome Receipt and the goal remains unable to use
the verified-completion path.

## 9. Persistence vocabulary

`goal/outcome-receipt` is added to the canonical known-event vocabulary and the
persistence catalog. It is ignorable/log-only and does not enter model-visible
history.

The full receipt is persisted before the immediately following
`goal/verification`, so that verification remains the latest durable event
consumed by the existing one-shot completion gate.

## 10. Hardening telemetry

`@deepseek-ai/dsh-agent-kernel-hardening` is upgraded to 0.7.0 and now counts:

- durable Outcome Receipts;
- Outcome Receipts with warnings;
- existing goal verification attempts/passes/failures separately.

This distinguishes "the verifier ran" from "an immutable evidence-backed proof
object was produced."

## 11. Native regression fixtures

The goal package ships native Vitest coverage for:

- receipt persistence immediately before `goal/verification`;
- receipt SHA-256 presence in verifier evidence;
- successful `completeVerified()` after a valid contract;
- no receipt on a failing contract;
- refusal to complete after failed acceptance.

Those tests are included for normal dependency-backed monorepo CI. The clean
archive environment lacks the installed pnpm/type dependency graph, so the
full native workspace suite is not claimed here.

## 12. Qualification

The dependency-independent v0.9 qualification proves:

- false completion is rejected;
- repair plans identify failed criteria;
- corrected outcomes pass;
- stale evidence is detected;
- receipt tampering is detected;
- artifact mutation is detected;
- stale goal revisions fail closed;
- successful goal evidence contains the exact receipt hash.

The dedicated package suite additionally covers contract cycles, verifier
version drift, deterministic-only required criteria, minimum evidence counts,
benchmark tolerances, artifact hashing, receipt lineage, evidence
contradictions, state-machine commit guards, criterion authority, telemetry,
incremental stale-only verification and trusted named checks.

## 13. Compatibility and deliberate boundaries

- The production runtime remains TypeScript.
- The Python agent kernel remains a reference/test oracle.
- Existing GoalService verifier APIs remain available.
- Outcome-contract integration is additive; deployments decide which goals use
  it rather than silently changing every existing workflow contract.
- `goal/outcome-receipt` is model-invisible and does not alter replayed chat.
- The core verifier package deliberately does not execute arbitrary shell
  commands. Deployment-owned named checks should bridge trusted test/build
  tools into the verifier registry.
- The project-reference typecheck reaches the host workspace dependency graph
  but the clean extracted environment lacks `@types/node` and the installed
  pnpm graph, so a complete upstream monorepo typecheck/CI pass is not claimed.

## 14. Next high-value work

1. persist Acceptance Contract/evidence/invalidation events as first-class
   durable session vocabulary rather than keeping the engine store process-local;
2. wire verification status and repair plans into Code Mode/DAG APIs so agents
   can run only stale criteria programmatically;
3. add first-party deployment check packs for tests, typecheck, packaging,
   security and benchmarks;
4. protect acceptance fixtures/golden files from worker mutation with explicit
   authority policy;
5. add model-verifier disagreement/contradiction review for criteria that
   cannot be deterministic;
6. dogfood an Acceptance Contract on the Harness release pipeline itself;
7. run dependency-backed full monorepo CI and paired task experiments measuring
   false-completion rejection, verified-success rate, cost and latency.
