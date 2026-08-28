# v0.18 Repair Controller Qualification Report

Generated: 2026-08-28T02:08:20.987Z

## Summary

| Metric | Value |
|--------|-------|
| Fixtures | 5 |
| Final verified | 3/5 |
| Holdout passed | 3/5 |
| Escalated to Pro | 0/5 |
| Total cost | $0.031861 |
| Total latency | 163589ms |

## Per-fixture results

| Task | Attempts | Flash | Pro | Verified | Holdout | Cost | Latency |
|------|----------|-------|-----|----------|---------|------|---------|
| implement-debounce | 1 | 1 | 0 | PASS | PASS | $0.005593 | 23929ms |
| implement-throttle | 1 | 1 | 0 | FAIL | FAIL | $0.004201 | 22781ms |
| implement-memoize | 1 | 1 | 0 | PASS | PASS | $0.010802 | 56080ms |
| fix-broken-sort | 1 | 1 | 0 | FAIL | FAIL | $0.004819 | 25729ms |
| implement-promise-pool | 1 | 1 | 0 | PASS | PASS | $0.006445 | 35070ms |

## Per-attempt detail

### implement-debounce

Category: code-implement
Description: Implement a debounce function with cancel
Final verified: true
Holdout pass: true
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | PASS | - | - | complete | $0.005593 |

### implement-throttle

Category: code-implement
Description: Implement a throttle function with leading edge
Final verified: false
Holdout pass: false
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | FAIL | - | - | complete | $0.004201 |

### implement-memoize

Category: code-implement
Description: Implement memoization with custom resolver
Final verified: true
Holdout pass: true
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | PASS | - | - | complete | $0.010802 |

### fix-broken-sort

Category: code-debug
Description: Fix a broken numeric sort function
Final verified: false
Holdout pass: false
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | FAIL | - | - | complete | $0.004819 |

### implement-promise-pool

Category: code-implement
Description: Implement a concurrency-limited promise pool
Final verified: true
Holdout pass: true
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | PASS | - | - | complete | $0.006445 |
