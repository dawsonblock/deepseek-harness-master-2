# DeepSeek Harness FULL upgraded corrected v0.11.0

v0.11 makes acceptance-pack enforcement a calibrated policy decision rather than a
manual mode flip.

## Main additions

- `AcceptancePackRegistry` with exact `id@version` resolution, latest-version lookup,
  descriptor validation, and deterministic registry fingerprinting.
- Statistical verifier-promotion policy for observe → enforce rollouts.
- Minimum total/valid/invalid labeled-case requirements.
- FAR/FRR release gates.
- 95% Wilson confidence intervals for finite-sample false-acceptance and
  false-rejection rates.
- Optional per-pack FAR/FRR gates.
- Promotion records bound to all three policy surfaces:
  - acceptance-pack registry fingerprint
  - verifier registry fingerprint
  - trusted-check registry fingerprint
- Automatic fallback to observe mode after any policy/version drift.
- `release-v2.json` acceptance calibration policy.
- CLI evaluator for benchmark/promotion artifacts.
- Expanded v0.11 adversarial calibration corpus: 150 labeled cases
  (50 valid, 100 invalid) across coding and release packs.

## Calibration result

The bundled v0.11 qualification corpus produced:

- 150/150 correctly classified
- 50 valid outcomes
- 100 deliberately invalid outcomes
- observed FAR = 0
- observed FRR = 0
- 95% Wilson FAR upper bound ≈ 0.0370
- promotion result = ENFORCE for the exact calibrated policy fingerprints
- modified verifier fingerprint test = automatic demotion to OBSERVE

The confidence-bound gate is intentionally more conservative than simply observing
zero errors. A smaller zero-error corpus can still be rejected as statistically
insufficient.

## Backward compatibility

The v0.10 observe/enforce adapter remains supported. v0.11 adds a safe promotion
layer on top; it does not rewrite the canonical session/event format or weaken the
v0.5-v0.9 recovery, verification-receipt, or one-shot completion guarantees.

## Validation boundary

Targeted package, recovery, process-kill, outcome, and verifier-calibration suites
are executed in the extracted environment. A complete dependency-backed upstream
pnpm monorepo CI run is not claimed because the clean source archive does not carry
its installed workspace dependency graph.
