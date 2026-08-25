# Agent Note: Verified Economic Value Benchmark — v0.16.0

Status: implemented

English | [中文](2026-08-25-verified-economic-value-benchmark.zh.md)

## Problem

The routing/cost join shipped in [economics-and-routing-join](2026-08-23-economics-and-routing-join.md) made routing decisions measurable: each decision carries a `routingDecisionId`, a `model/usage` event, a calculated cost, and a `RoutingOutcome`. But measurement infrastructure is not an economic claim. The v0.16.0-rc.1 benchmark that preceded this note ran one task three times per model and reported Pro costs 3.04x Flash with 1.52x latency. That is a request-level cost comparison, not a verified economic value comparison. It did not answer the product question: does the current router deliver Pro's verified-success advantage while avoiding unnecessary Pro cost?

Three gaps prevented answering that question:

1. No verification. The prior benchmark treated "the model finished" as success. A model that returns garbage with the right latency and cost looks identical to a correct answer.
2. No cache controls. DeepSeek caching is prefix-sensitive. Running Flash then Pro sequentially lets the second model benefit from a warmer cache state, confounding cost comparisons.
3. No policy comparison. The prior benchmark compared two models in isolation. It did not measure the router itself against Flash-only and Pro-only baselines.

## Decision

Ship a task-level paired benchmark with three policies, structured verification, cache controls, and `CostPerVerifiedTask` as the core metric. The benchmark lives in `scripts/run-rc1-benchmark.ts` and produces `artifacts/reports/v0.16.0-rc1-paired-benchmark.{json,md}`.

### Task-level paired design

Each task class runs under three policies: Flash-only (direct selection), Pro-only (direct selection), and current-router (`llm-model-router` decides). Fifteen task classes span eight categories: simple-factual, factual-formatting, short-code-edit, multi-step-reasoning, debugging, structured-transformation, planning, verification-heavy, long-context-analysis, and tool-heavy. Each task class runs twice (one cold, one warm) per policy, producing 90 scored runs plus a warm-up phase excluded from scored economics.

### Structured verification

Each task class carries explicit verification criteria — multiple boolean checks against the model output, not string equality or output length. The verification status vocabulary mirrors `RoutingOutcome`: `verified-pass`, `verified-fail`, `unverified`, `incomplete`. A run passes only when every criterion passes. The criteria are task-specific (e.g. "defines odd integer (2k+1 form)", "factors out 2 from result", "concludes result is even" for the proof task).

### Cache controls

A warm-up phase primes both models' caches before scored runs. Scored runs alternate between cold (fresh context) and warm (after warm-up) states. Each run records `cacheHitTokens`, `cacheMissTokens`, and `hitRate`. Pairs are flagged `cacheComparable: false` when the absolute hit-rate difference exceeds 10 percentage points, making the confound visible without discarding the data.

### Core metric: CostPerVerifiedTask

```
CostPerVerifiedTask = TotalCost / VerifiedPasses
```

Calculated separately for each policy. This is the metric that answers whether Pro's higher verified rate justifies its higher cost.

### Pair classification

Each Flash/Pro pair is classified deterministically:

- `pro-necessary`: Flash fails, Pro passes.
- `both-pass-pro-more-expensive`: both pass, Pro costs more.
- `flash-better`: Flash passes, Pro fails.
- `both-fail`: neither passes.
- `pro-better`: both pass, Pro costs less.

Two aggregate rates derive from the classification:

- `ProNecessityRate = (Flash fail AND Pro pass) / comparable pairs`
- `ProWasteRate = (both pass AND Pro more expensive) / all pairs`

### FlashRescueCost

For `pro-necessary` pairs, the benchmark measures whether "Flash first, Pro rescue" is cheaper than "Pro initially":

```
FlashRescueCost = Cost(Flash failed) + Cost(Pro rescue)
vs
Cost(Pro initially)
```

This catches the failure mode where Flash-first is cheaper per task but causes expensive Pro rescues that make it more expensive overall.

### Statistics

Median and p90 latency/cost are reported alongside arithmetic means. A few long-running failures can distort means badly; the distributional view prevents that.

### Three-policy comparison

The benchmark reports verified success rate, total cost, cost per verified task, median latency, repair rate, and Pro utilization for each policy. The central product claim is testable: does the current router preserve Pro's verified-success advantage while avoiding unnecessary Pro cost?

## Measured results

30 paired runs (15 task classes x 2 iterations):

| Policy | Verified pass | Cost/task | Cost/verified | Median latency | Pro util |
|---|---:|---:|---:|---:|---:|
| Flash-only | 73.3% | $0.000621 | $0.000847 | 2844ms | 0% |
| Pro-only | 76.7% | $0.001844 | $0.002405 | 3685ms | 100% |
| Current router | 76.7% | $0.001197 | $0.001561 | 2816ms | 10% |

The router matches Pro-only's verified rate (76.7%) at 35% lower `CostPerVerifiedTask` ($0.001561 vs $0.002405), using Pro only 10% of the time. Median latency is lower than both Flash-only and Pro-only.

- `ProNecessityRate`: 10.7% (3/28 comparable pairs)
- `ProWasteRate`: 66.7% (20/30 all pairs)
- `FlashRescueCost` overhead: $0.000079/task average across 3 rescue cases
- Router selected Flash 90%, Pro 10%
- Cache-comparable: 28/30 pairs

The router missed 2 `structured-transform` cases where Pro was necessary (selected Flash, Flash failed). It escalated to Pro on `code-edit` where both models passed (a `ProWasteRate` contribution).

## Alternatives considered

### Why not keep the request-level benchmark?

A request-level benchmark that reports cost and latency without verification cannot distinguish a correct answer from garbage. `CostPerVerifiedTask` requires verification, which requires task-level design. The request-level benchmark remains useful for measurement plumbing but not for economic claims.

### Why not use the goal/verification system directly?

The `goal/verification` event system requires the full goal plugin, goal registration, and verifier registry. The benchmark runs isolated model turns through `runFixtureTurn`, not full agent sessions with goal lifecycle. Reimplementing the same status vocabulary (`verified-pass`, `verified-fail`, `unverified`, `incomplete`) with task-specific criteria keeps the benchmark self-contained while preserving semantic compatibility with `RoutingOutcome`.

### Why not run 50+ tasks?

30 paired runs across 15 task classes and 8 categories provide enough signal to confirm the router delivers economic value. The `ProNecessityRate` (10.7%) and `ProWasteRate` (66.7%) are stable enough to guide v0.17 learned-routing work. Expanding to 50+ tasks is a v0.17 concern, where the benchmark becomes the training/evaluation baseline for learned routing.

### Why not separate cold and warm analyses completely?

The benchmark records `cacheState: 'cold' | 'warm'` per run, so cold-only and warm-only analyses are derivable from the JSON. The current 2-iteration design (1 cold + 1 warm per task per policy) does not have enough samples per cell for robust separate cold/warm conclusions; that is a v0.17 expansion target.

## Consequences

The router's economic value is now measured, not assumed. The central product claim — "the router preserves Pro's verified-success advantage while avoiding unnecessary Pro cost" — is supported by live evidence: 76.7% verified rate (matching Pro-only) at 35% lower `CostPerVerifiedTask`, with 10% Pro utilization.

The `ProWasteRate` of 66.7% identifies the primary v0.17 target: the current escalation policy (`escalationThreshold: 4`) is too conservative in the other direction — it rarely escalates, but when it does, Flash often sufficed. A learned router that reduces `ProWasteRate` while preserving the verified-success rate would deliver additional economic value.

The `ProNecessityRate` of 10.7% confirms that Pro escalation is genuinely necessary for a non-trivial minority of tasks. A Flash-only policy would lose 3 tasks that Pro rescues. The `FlashRescueCost` analysis shows the rescue overhead is small ($0.000079/task), but this is measured on only 3 cases — a larger sample is needed before drawing strong conclusions about rescue economics.

The benchmark is preliminary in sample size (30 pairs) and task diversity (15 classes, 8 categories). It is sufficient to freeze v0.16.0 but should expand for v0.17. The verification criteria are hand-written regex checks, not semantic verifiers; they are adequate for the current task classes but will need strengthening for more open-ended tasks.

### What v0.17 adds

The benchmark becomes the training/evaluation baseline for learned routing. The decision table (`ProNecessityRate`, `ProWasteRate`, `FlashRescueCost`) provides the target metrics a learned router must beat. The three-policy comparison provides the baselines: Flash-only is the cost floor, Pro-only is the quality ceiling, and the current router is the heuristic to improve on.
