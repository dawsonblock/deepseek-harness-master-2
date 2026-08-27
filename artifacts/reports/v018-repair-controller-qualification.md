# v0.18 Repair Controller Qualification Report

Generated: 2026-08-27T00:35:35.171Z

## Summary

| Metric | Value |
|--------|-------|
| Fixtures | 5 |
| Final verified | 4/5 |
| Holdout passed | 4/5 |
| Escalated to Pro | 2/5 |
| Total cost | $0.320740 |
| Total latency | 2134644ms |

## Per-fixture results

| Task | Attempts | Flash | Pro | Verified | Holdout | Cost | Latency |
|------|----------|-------|-----|----------|---------|------|---------|
| implement-debounce | 1 | 1 | 0 | PASS | PASS | $0.003837 | 40450ms |
| implement-throttle | 4 | 2 | 2 | FAIL | FAIL | $0.209237 | 1333401ms |
| implement-memoize | 2 | 2 | 0 | PASS | PASS | $0.032594 | 308204ms |
| fix-broken-sort | 3 | 2 | 1 | PASS | PASS | $0.071750 | 404646ms |
| implement-promise-pool | 1 | 1 | 0 | PASS | PASS | $0.003322 | 47943ms |

## Per-attempt detail

### implement-debounce

Category: code-implement
Description: Implement a debounce function with cancel
Final verified: true
Holdout pass: true
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | PASS | - | - | complete | $0.003837 |

### implement-throttle

Category: code-implement
Description: Implement a throttle function with leading edge
Final verified: false
Holdout pass: false
Escalated to Pro: true

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | FAIL | e3b0c44298fc1c14 | none | flash-repair | $0.002541 |
| 2 | deepseek-v4-flash | PASS | FAIL | e3b0c44298fc1c14 | resolved | pro-escalate | $0.029924 |
| 3 | deepseek-v4-pro | PASS | FAIL | e3b0c44298fc1c14 | resolved | pro-escalate | $0.033159 |
| 4 | deepseek-v4-pro | PASS | FAIL | e3b0c44298fc1c14 | resolved | stop | $0.143613 |

### implement-memoize

Category: code-implement
Description: Implement memoization with custom resolver
Final verified: true
Holdout pass: true
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | FAIL | e3b0c44298fc1c14 | none | flash-repair | $0.002577 |
| 2 | deepseek-v4-flash | PASS | PASS | - | - | complete | $0.030017 |

### fix-broken-sort

Category: code-debug
Description: Fix a broken numeric sort function
Final verified: true
Holdout pass: true
Escalated to Pro: true

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | FAIL | e3b0c44298fc1c14 | none | flash-repair | $0.001814 |
| 2 | deepseek-v4-flash | PASS | FAIL | e3b0c44298fc1c14 | resolved | pro-escalate | $0.033254 |
| 3 | deepseek-v4-pro | PASS | PASS | - | - | complete | $0.036683 |

### implement-promise-pool

Category: code-implement
Description: Implement a concurrency-limited promise pool
Final verified: true
Holdout pass: true
Escalated to Pro: false

| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |
|---|-------|-----------|---------|-------------|----------|--------|------|
| 1 | deepseek-v4-flash | PASS | PASS | - | - | complete | $0.003322 |
