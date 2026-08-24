# DeepSeek Harness FULL upgraded corrected v0.12.0

v0.12 shifts the verification program from adding architecture to measuring whether
the existing proof system reliably separates valid from invalid candidate outcomes.

## Main additions

- Failure-taxonomy-aware verifier benchmarking.
- `VerifiedSuccessUpliftSummary` for comparing unverified candidate-completion
  precision against verifier-accepted precision and valid-work retention.
- Hash-bound `VerificationPromotionReceipt`.
- Promotion receipts bind:
  - benchmark fingerprint
  - benchmark summary hash
  - promotion policy hash
  - acceptance-pack registry fingerprint
  - verifier registry fingerprint
  - trusted-check registry fingerprint
- Missing, expired, tampered, or policy-drifted promotion receipts fail back to
  `observe` mode.
- Release acceptance policy v3 requests `enforce` but requires a valid calibrated
  promotion receipt before enforcement is activated.
- 1,600-case adversarial calibration corpus:
  - 500 valid
  - 1,100 deliberately invalid
  - 16 reported fault/control taxonomy classes
  - observed FAR = 0
  - observed FRR = 0
  - 95% Wilson FAR upper bound ~= 0.00348
- 40-case executable coding fixture benchmark using actual temporary JavaScript
  candidate artifacts, Node syntax checking, behavioral execution, and runtime
  integrity evidence.
- On the executable fixture set, verifier-accepted outcome precision improves from
  25% (accept-every-candidate baseline) to 100%, with 100% valid-case retention.
- Historical v0.11 source guard corrected to permit forward-compatible package minor
  versions rather than pinning exactly 0.3.0.

## Release-enforcement model

```text
calibrated pack + verifiers + trusted checks
                 |
                 v
          labeled benchmark
                 |
                 v
          FAR / FRR + CI
                 |
                 v
        promotion decision
                 |
                 v
       hash-bound receipt
                 |
        +--------+---------+
        |                  |
  policy matches       policy drift
        |                  |
        v                  v
     ENFORCE             OBSERVE
```

The receipt is a calibration authorization, not a cryptographic signature from an
external trust root. It detects content/policy drift through canonical hashing inside
the event/release system.

## Qualification result

The bundled v0.12 qualification produces 1,600/1,600 correct labeled decisions and
40/40 correct executable coding-fixture decisions. All prior targeted recovery,
process-kill, outcome, acceptance-pack, and Python reference qualifications remain
green in this extracted environment.

## Validation boundary

A full dependency-backed upstream pnpm monorepo CI pass is still not claimed from the
clean extracted source tree because its installed workspace dependency graph is not
present. The upgraded packages and dependency-free qualification paths are tested
independently.
