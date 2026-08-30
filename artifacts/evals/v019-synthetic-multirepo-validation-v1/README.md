# v0.19 Real-Repository Baseline Evaluation

Experiment ID: v019-infra-validation-v1
Source commit: a10037e23afb
Frozen v0.18 tag: v0.18.0
Manifest hash: b3fe9923967c6ffd3ca6d73f81b41143f95ed1328b0164f6955341824e1db0b4
Benchmark eligible: false
Generated: 2026-08-30T20:52:08.556Z

## Summary

| Metric | Value |
|--------|-------|
| Tasks | 2 |
| Evaluated tasks | 0 |
| Infra failures | 0 |
| Verified task rate | 0.0% |
| One-shot Flash rate | 0.0% |
| Repair rescue rate | 0.0% |
| Flash self-repair rate | 0.0% |
| Pro escalation rate | 0.0% |
| Pro rescue rate | 0.0% |
| Mean attempts/task | 0.00 |
| Mean cost/task | $0.000000 |
| Median cost/task | $0.000000 |
| Mean cost/verified | $0.000000 |
| Latency P50 | 0ms |
| Latency P90 | 0ms |
| Latency P95 | 0ms |
| Budget stop rate | 0.0% |
| Provider failure rate | 0.0% |
| Reference-fix file miss rate | 0.0% |
| Reference-fix file inspection rate | 0.0% |
| Reference-fix file inspection recall | 0.0% |
| Cache hit % | 0.0% |
| Flash cost share | 0.0% |
| Pro cost share | 0.0% |

## Category breakdown

| Category | N | Verified | One-shot | Flash repair | Pro rescue | Failed | Mean cost | Mean latency |
|----------|---|----------|----------|--------------|------------|--------|-----------|--------------|
| bug-fix | 2 | 0 | 0 | 0 | 0 | 0 | $0.000000 | 0ms |

## Failure taxonomy

| Category | Count |
|----------|-------|
| F13-rollback | 2 |

## Control-plane integrity

| Invariant | Count |
|-----------|-------|
| Provider failures | 0 |
| Control-plane failures | 2 |
| Budget stops | 0 |
| Rollbacks | 0 |

## Policy freeze

The v0.18.0 repair controller policy was frozen for this entire cohort:
- maxFlashAttempts: 3
- maxProAttempts: 2
- maxTotalAttempts: 5

No threshold tuning, limit changes, or policy modifications were made during collection.
