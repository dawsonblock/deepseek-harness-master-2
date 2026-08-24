# @deepseek-ai/dsh-outcome-verification

Evidence-driven completion for DeepSeek Harness.

This package turns a natural-language goal into a machine-readable **Acceptance Contract**, runs versioned deterministic/external verifiers, records immutable evidence, invalidates stale evidence when dependencies change, generates structured repair plans, and emits a hashed **Outcome Receipt** only when completion policy passes.

## Core invariant

> Autonomous completion is a claim. An Outcome Receipt is the evidence-backed proof object for that claim.

The package is intentionally independent of the model loop. It integrates structurally with `GoalService.registerAcceptanceVerifier()` through `createGoalOutcomeVerifier()` so the existing policy-bound, one-shot `completeVerified()` gate remains the final commit authority.

## Flow

```text
AcceptanceContract
      |
      v
VerifierRegistry ---- policy fingerprint
      |
      v
OutcomeVerificationEngine
      |
      +--> EvidenceStore -- dependency invalidation --> STALE
      |
      +--> ContractVerificationReport
                |
          fail  |  pass
          v     |   v
      RepairPlan| OutcomeReceipt
                |     |
                +-----+--> GoalService verification evidence
```

## Safety properties

- Required criteria can be configured to require deterministic verifiers.
- Verifier IDs and versions are bound into the policy fingerprint.
- Receipt hashes bind the contract, policy fingerprint, criterion evidence, artifacts, warnings and verdict.
- A failing report cannot produce a receipt.
- Evidence is append-only; invalidation does not mutate historical evidence.
- Dependency invalidation makes previously passing evidence `STALE`.
- Required stale evidence fails completion by default.
- Criterion dependency cycles are rejected.
- Goal id/revision mismatches fail the goal adapter closed.

## Built-in verifiers

- `value.equals`
- `number.minimum`
- `number.maximum`
- `benchmark.no-regression`
- `artifact.sha256`
- `runtime.no-unresolved-side-effects`

The package deliberately does not execute arbitrary shell commands. Command/test/build verifiers should be supplied by a trusted deployment tool layer so the verifier cannot become a second unrestricted execution surface.

## Incremental verification

`verifyStale()` reuses fresh passing evidence and reruns only criteria whose evidence is missing, failing, or invalidated. `createTrustedNamedCheckVerifier()` lets deployments expose reviewed test/build/security gates by stable id without embedding arbitrary shell commands in contracts.

## v0.10 acceptance packs

The package includes versioned contract factories for runtime, coding, research, deployment, data-pipeline, and Harness release workflows. Packs reference reviewed trusted-check ids rather than arbitrary command strings.

Use `TrustedCheckRegistry` + `createTrustedCheckVerifier()` to bind those ids to deployment-owned deterministic checks. The registry and pack versions participate in verification policy/contract hashing.

## Verifier calibration

`runVerificationBenchmark()` and `summarizeVerificationBenchmark()` evaluate labeled valid/invalid candidate outcomes and report false-acceptance rate (FAR) and false-rejection rate (FRR). `decideVerification()` supports observe-mode rollout before enabling fail-closed enforcement.

## Observe → enforce promotion (v0.11)

Acceptance packs can be calibrated in `observe` mode and promoted to `enforce`
only after a labeled benchmark satisfies a `VerificationPromotionPolicy`.
Promotion is conservative in two ways:

1. it gates observed false-acceptance/false-rejection rates and minimum corpus sizes;
2. it can gate the 95% Wilson upper confidence bound, so `FAR = 0` on a tiny corpus
   is not treated as strong evidence.

Promotion decisions can be bound to the exact fingerprints of the acceptance-pack,
verifier, and trusted-check registries. Any policy drift demotes the effective mode
back to `observe` until the changed policy is recalibrated.

Use `AcceptancePackRegistry` to register versioned pack factories and
`evaluateVerificationPromotion()` / `resolvePromotedVerificationMode()` to build a
controlled rollout. The root CLI helper can evaluate exported benchmark observations:

```bash
npm run build:outcome-verification
node scripts/evaluate-verifier-promotion-v11.mjs benchmark.json config/acceptance/release-v2.json
```

## v0.12 empirical calibration and enforcement receipts

v0.12 adds a failure taxonomy and a verified-success uplift view on top of FAR/FRR.
`summarizeFailureTaxonomy()` reports false accepts/rejects by stable adversarial class,
while `summarizeVerifiedSuccessUplift()` compares an unverified "accept every
candidate-complete result" baseline against the precision of the verifier-accepted set.

Observe -> enforce promotion now has an immutable, hash-bound
`VerificationPromotionReceipt`. `resolveVerificationModeWithPromotionReceipt()` only
returns `enforce` when the receipt hash, promotion policy, acceptance-pack registry,
verifier registry, and trusted-check registry still match. Policy drift, receipt
tampering, expiry, or a missing receipt falls back to `observe`.

The bundled v0.12 release calibration uses 1,600 labeled cases (500 valid, 1,100
invalid) across coding and release packs. The current qualification result is FAR=0,
FRR=0 with a 95% Wilson FAR upper bound of about 0.00348. The repository also runs a
40-case executable coding fixture benchmark using actual temporary JavaScript
artifacts, Node syntax checking, and behavioral execution; on that fixture set the
accepted-outcome precision improves from a 25% unverified baseline to 100%, with all
valid cases retained.


## v0.13 per-pack calibration and mutation testing

v0.13 prevents aggregate benchmark strength from hiding a weak task domain. `VerificationPromotionPolicy.requiredPacks` can now require independent valid/invalid sample counts, FAR/FRR thresholds, Wilson confidence bounds, named adversarial fault classes, minimum mutation counts, and mutation kill-rate thresholds for each acceptance pack.

`generateVerificationMutations()` derives invalid benchmark candidates from known-valid seeds while preserving the mutation operator and seed identity. `summarizeMutationCalibration()` reports killed versus surviving mutations. v2 promotion receipts additionally bind the hash of the complete per-pack calibration surface.

The bundled v0.13 calibration covers all six standard packs with 2,100 labeled outcomes (600 valid, 1,500 invalid), 150 mutation-derived invalid outcomes per pack, observed FAR=0/FRR=0, and a global 95% Wilson FAR upper bound of roughly 0.00255. A separate executable coding mutation benchmark runs actual temporary JavaScript artifacts and requires all seeded logic, syntax, and unresolved-side-effect mutations to be killed.
