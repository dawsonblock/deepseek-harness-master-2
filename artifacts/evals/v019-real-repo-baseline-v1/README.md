# v0.19 Real-Repository Baseline Evaluation

Experiment ID: v019-infra-validation-v1
Source commit: 7f5b7f800cc4
Frozen v0.18 tag: v0.18.0
Manifest hash: 13dd257498bb83fe640301ed13a090c6635c13a4c1d9ed59fdae5a89464e65ff
Benchmark eligible: false
Generated: 2026-08-28T04:46:52.958Z

## Summary

| Metric | Value |
|--------|-------|
| Tasks | 5 |
| Evaluated tasks | 5 |
| Infra failures | 0 |
| Verified task rate | 100.0% |
| One-shot Flash rate | 100.0% |
| Repair rescue rate | 0.0% |
| Flash self-repair rate | 0.0% |
| Pro escalation rate | 0.0% |
| Pro rescue rate | 0.0% |
| Mean attempts/task | 1.00 |
| Mean cost/task | $0.002656 |
| Median cost/task | $0.002253 |
| Mean cost/verified | $0.002656 |
| Latency P50 | 17688ms |
| Latency P90 | 35837ms |
| Latency P95 | 35837ms |
| Budget stop rate | 0.0% |
| Provider failure rate | 0.0% |
| Reference-fix file miss rate | 0.0% |
| Reference-fix file inspection rate | 0.0% |
| Cache hit % | 91.8% |
| Flash cost share | 100.0% |
| Pro cost share | 0.0% |

## Category breakdown

| Category | N | Verified | One-shot | Flash repair | Pro rescue | Failed | Mean cost | Mean latency |
|----------|---|----------|----------|--------------|------------|--------|-----------|--------------|
| bug-fix | 3 | 3 | 3 | 0 | 0 | 0 | $0.002827 | 24016ms |
| multi-file-feature | 2 | 2 | 2 | 0 | 0 | 0 | $0.002400 | 16122ms |

## Failure taxonomy

| Category | Count |
|----------|-------|

## Control-plane integrity

| Invariant | Count |
|-----------|-------|
| Provider failures | 0 |
| Control-plane failures | 0 |
| Budget stops | 0 |
| Rollbacks | 0 |

## Policy freeze

The v0.18.0 repair controller policy was frozen for this entire cohort:
- maxFlashAttempts: 3
- maxProAttempts: 2
- maxTotalAttempts: 5

No threshold tuning, limit changes, or policy modifications were made during collection.
