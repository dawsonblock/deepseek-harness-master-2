# DeepSeek Harness FULL upgraded corrected v0.10.0

v0.10 turns the v0.9 Outcome Verification Engine into a reusable domain verification layer and adds a labeled verifier-quality benchmark.

## What changed

### Versioned acceptance packs

The native outcome package now ships `@1` contract factories for:

- runtime
- coding
- research
- deployment
- data pipeline
- release engineering

Contracts record pack id/version in the contract hash. Required pack criteria are system-owned by default so a worker cannot silently weaken them.

### Trusted Check Registry

`TrustedCheckRegistry` is a deployment-owned allow-list of reviewed deterministic checks. Acceptance contracts reference stable ids such as `tests-pass` or `archive-manifest-valid`; they do not embed arbitrary shell command strings. The trusted-check registry is itself fingerprintable by id/version.

### Deterministic verifier primitives

Added:

- `artifact.exists`
- `artifact.nonempty`
- `runtime.recovery-clean`
- `evidence.no-contradictions`
- `external.resource-exists`

These extend the existing value, numeric, benchmark, artifact hash, and unresolved-side-effect verifiers.

### Observe/enforce rollout mode

`decideVerification()` supports:

- `observe`: report would-accept/would-reject without blocking legacy completion
- `enforce`: verification verdict controls completion

This supports calibrating new packs before fail-closed rollout.

### FAR / FRR verifier benchmarking

Added a labeled benchmark framework that records ground truth and calculates:

- true accepts
- true rejects
- false accepts
- false rejects
- false-acceptance rate (FAR)
- false-rejection rate (FRR)
- verification latency
- verifier runs
- evidence volume
- repair rounds

`assertVerificationBenchmarkGate()` can fail a release when FAR or FRR exceeds policy.

The hardening package also exposes verification-observation summaries and paired pack comparisons so verifier changes can be measured instead of judged subjectively.

### Release-pack dogfooding scaffold

`config/acceptance/release-v1.json` declares the first Harness release contract policy and trusted check ids. It defaults to observe mode and requires zero false acceptances before promotion toward enforcement.

## Safety objective

The central metric for the next stage is no longer "did the agent say it completed?" It is:

> Given labeled correct and deliberately broken candidate outcomes, how often does the verifier incorrectly accept broken work or reject valid work?

Critical deterministic qualification should target zero false acceptance on the maintained corpus.

## Compatibility

The v0.9 goal/outcome receipt integration remains authoritative. v0.10 adds pack/compiler/benchmark layers without replacing the existing one-shot `completeVerified()` commit or recovery semantics.
