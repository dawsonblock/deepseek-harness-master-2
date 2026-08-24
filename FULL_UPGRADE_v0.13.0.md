# DeepSeek Harness FULL Upgrade v0.13.0

## Release objective

v0.13.0 closes an empirical-governance gap in v0.12: a strong aggregate verifier score could still hide an under-tested acceptance pack. The release adds independent per-pack calibration, explicit adversarial mutation provenance, mutation kill-rate gates, and v2 promotion receipts that bind the complete per-pack calibration surface.

## Core additions

### Per-pack promotion gates

`VerificationPromotionPolicy.requiredPacks` can independently require, for every pack:

- minimum total, valid, and invalid cases;
- observed FAR and FRR thresholds;
- 95% Wilson FAR/FRR upper-bound thresholds;
- named adversarial fault-class coverage;
- minimum mutation-derived case counts;
- minimum mutation kill rate.

A required pack with no observations fails promotion even when aggregate FAR/FRR are perfect.

### Adversarial mutation framework

`generateVerificationMutations()` derives invalid candidates from known-valid seeds and records:

- mutation operator id;
- originating seed id;
- pack id;
- fault class.

`summarizeMutationCalibration()` reports killed/surviving mutations and the mutation kill rate. A surviving mutation is a concrete false-acceptance signal and can block promotion.

### Stable benchmark fingerprinting

Benchmark fingerprint normalization now omits absent optional provenance fields instead of attempting to canonicalize explicit JavaScript `undefined` values. Semantically identical observations therefore hash identically whether optional keys are omitted or explicitly undefined.

### v2 promotion receipts

New promotion receipts include `packCalibrationHash`, binding enforcement authorization to the independently calibrated pack surface in addition to the benchmark, promotion policy, acceptance-pack registry, verifier registry, and trusted-check registry.

Historical v1 promotion receipts remain verifiable under their original policy for backward compatibility.

## v0.13 release calibration

The release calibration covers all six standard acceptance packs:

- runtime
- coding
- research
- deployment
- data-pipeline
- release

Each pack contributes 100 valid and 250 invalid cases. Each includes 150 mutation-derived invalid cases and must kill all 150.

Aggregate calibration:

- 2,100 labeled cases
- 600 valid
- 1,500 invalid
- false accepts: 0
- false rejects: 0
- observed FAR: 0
- observed FRR: 0
- 95% Wilson FAR upper bound: approximately 0.00255

Per pack:

- 350 cases
- 100 valid
- 250 invalid
- 150 mutation-derived invalid cases
- mutation kill rate: 1.000
- per-pack 95% FAR upper bound below 0.016

## Executable mutation qualification

A separate repository-local fixture suite creates real temporary JavaScript artifacts from valid seeds and applies three mutations:

- logic corruption (`a+b` -> `a-b`)
- syntax corruption
- unresolved-side-effect injection

The coding acceptance pack evaluates them through Node syntax checking, behavioral execution, and runtime side-effect verification.

Result:

- 40 valid controls retained
- 120/120 mutations killed
- 0 surviving mutations
- FAR 0
- FRR 0

## Enforcement behavior

`release-v4.json` requests enforce mode, but `resolveVerificationModeWithPromotionReceipt()` only returns `enforce` when the v2 promotion receipt matches the current:

- promotion policy hash;
- pack registry fingerprint;
- verifier registry fingerprint;
- trusted-check registry fingerprint.

Any drift or receipt tampering falls back to `observe`.

## Compatibility

Acceptance pack contract versions remain `@1`; their contract semantics were not changed. The outcome-verification package moves from 0.4.0 to 0.5.0 because calibration and promotion semantics changed.

The v0.12 source guard was made forward-compatible with later outcome-verification package minor versions.

## Qualification boundary

This release has strong targeted validation of the upgraded runtime and verification layers. It does not claim a full dependency-installed upstream pnpm monorepo CI pass in the clean extracted archive environment.
