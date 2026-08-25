# Agent Note: v0.17.0 Offline Evaluation — Learned Pro-Necessity Predictor

Status: implemented

English | [中文](2026-08-25-v017-offline-evaluation-learned-router.zh.md)

## Problem

The v0.16.0 benchmark measured the heuristic router's economic value: it matches Pro-only's verified rate (76.7%) at 35% lower `CostPerVerifiedTask`, but carries a 66.7% `ProWasteRate`. The natural next question is whether a learned router can reduce waste while preserving verified success. The heuristic router uses a deterministic complexity scorer with 5 signal families (reasoning requests, math markers, architecture markers, code blocks, length bands) and an escalation threshold. It cannot distinguish "structured-transform" tasks (where Pro is necessary) from "yaml-to-json" tasks (where Flash suffices) because both have zero complexity signals.

## Decision

Ship an offline evaluation that trains a logistic regression Pro-necessity predictor on the frozen v0.16.0 benchmark dataset and compares it against the heuristic router on `CostPerVerifiedTask`. The evaluation lives in `scripts/run-v017-offline-evaluation.ts` and produces `artifacts/reports/v0.17.0-offline-evaluation.{json,md}`.

### Dataset partitioning

The 30 paired examples (15 task classes x 2 iterations) are partitioned by task class into train (9 tasks, 18 examples), validation (3 tasks, 6 examples), and test (3 tasks, 6 examples). Splitting by task class prevents training and evaluating on the same task, which would overfit to task-specific patterns rather than learning generalizable complexity-to-necessity mapping.

### Learning label

The primary label is binary Pro-necessity: `1` when Flash fails and Pro passes, `0` otherwise. This directly targets the routing question "is Pro worth paying for?" A delta-U utility analysis supplements the binary label with continuous verified-outcome difference and cost difference per task.

### Features

Seven pre-routing features extracted from the task text using the existing complexity scorer, preserving the invariant `featureSeq < routingDecisionSeq`:

- `explicitReasoningRequests`, `mathMarkers`, `architectureMarkers`, `codeBlocks`, `lengthBands` (the 5 signal families)
- `complexityScore` (the capped weighted sum the heuristic router uses)
- `promptLength` (raw character count)

No post-decision information leaks into features.

### Model

Logistic regression trained from scratch (no external ML dependency). Standardized features, gradient descent, 500 iterations, learning rate 0.1. The optimal decision threshold is selected on the validation partition by minimizing `CostPerVerifiedTask` subject to verified rate >= 70%.

### Policy comparison

Four policies evaluated on the test partition:
- Flash-only (never use Pro)
- Pro-only (always use Pro)
- Heuristic router (complexity score >= 4)
- Learned router (logistic regression >= optimal threshold)

### Architecture for live deployment

The intended live architecture layers deterministic gates before the learned predictor:

```
Manual / authority constraints
        ↓
Hard routing constraints
        ↓
Learned Pro-necessity predictor
        ↓
confidence threshold
    ┌───┴───┐
    ↓       ↓
  Flash     Pro
```

v0.17.0 is offline evaluation only. v0.17.1 should run the learned router in shadow mode while the heuristic router continues controlling execution. Promotion only after the learned router demonstrably improves `CostPerVerifiedTask` without materially declining verified success.

## Measured results

### Test partition (3 task classes, 6 examples)

| Policy | Verified | Cost/verified | Pro util | ProNecessity recall | ProWaste rate |
|---|---:|---:|---:|---:|---:|
| Flash-only | 50.0% | $0.001054 | 0% | 0% | 0% |
| Pro-only | 66.7% | $0.002248 | 100% | 100% | 33% |
| Heuristic router | 50.0% | $0.001054 | 0% | 0% | 0% |
| Learned router | 50.0% | $0.001054 | 0% | 0% | 0% |

At the default threshold (0.5), the learned router defaults to Flash-only. The heuristic router also defaults to Flash-only on the test partition because all 3 test task classes have complexity score 0.

### Threshold sweep

| Threshold | Verified | Cost/verified | Pro util | ProNecessity recall | ProWaste rate |
|---:|---:|---:|---:|---:|---:|
| 0.01 | 66.7% | $0.002248 | 100% | 100% | 33% |
| 0.08 | 66.7% | $0.001406 | 67% | 100% | 0% |
| 0.10 | 50.0% | $0.001054 | 0% | 0% | 0% |

At threshold 0.08, the learned router catches all pro-necessary cases (100% recall) with 0% waste and 67% Pro utilization. At 0.10, it misses them all. The model assigns 8.1% probability to the structured-transform tasks — the decision boundary is razor-thin.

### Delta-U analysis

Across all 30 examples:
- 3 tasks with delta-U = +1 (Pro necessary): `factual-explain/2`, `structured-transform/1`, `structured-transform/2`
- 2 tasks with delta-U = -1 (Flash better): `factual-explain/1`, `yaml-to-json/1`
- 25 tasks with delta-U = 0 (no verified difference)

The 3 pro-necessary cases have zero complexity signals. The heuristic router's 5 signal families cannot detect them. The learned router, using the same features, also cannot distinguish them from the 25 zero-delta-U tasks with zero complexity signals. The features are insufficient.

## Alternatives considered

### Why not use a neural router?

With 30 examples and 3 positive labels, a neural network would overfit catastrophically. Logistic regression is the appropriate model complexity for this sample size. A neural router is a v0.18+ concern after the dataset expands to 100+ paired tasks.

### Why not use gradient-boosted trees?

GBT handles non-linear feature interactions better than logistic regression, but with 7 features and 30 examples, the linear model is sufficient and more interpretable. GBT should be tried after dataset expansion.

### Why not use a utility-based continuous label instead of binary?

The delta-U analysis is included as a diagnostic, but the binary label directly targets the routing decision. A continuous utility label (e.g. `U = verified - lambda * cost`) would require tuning `lambda`, which adds a hyperparameter with no clear calibration on 30 examples. The binary label is the simplest defensible target.

### Why not cross-validate?

Leave-one-task-out cross-validation on 15 task classes would give 15 folds, but each fold trains on 14 tasks and tests on 1 — high variance with 2 examples per task. The single 60/20/20 split is more interpretable and the small sample size means any split has high variance. Cross-validation should be added when the dataset expands.

## Consequences

The offline evaluation confirms that the current 7 pre-routing features (derived from the complexity scorer) are insufficient to predict Pro-necessity. The 3 pro-necessary cases (`structured-transform`, `factual-explain`) have zero complexity signals — they look identical to the 25 cases where Pro is unnecessary. No logistic regression on these features can separate them.

The path to a useful learned router requires richer features beyond text complexity scoring:

1. **Task category embedding**: the category itself (structured-transformation vs simple-factual) is predictive, but it requires a task classifier, which is another learned model.
2. **Historical outcome features**: if the harness has seen similar tasks before, the historical Flash/Pro pass rate for that task category is informative. This requires accumulating benchmark data across sessions.
3. **Output-length prediction**: tasks that require longer structured output (JSON conversion) may correlate with Pro necessity. This requires a pre-routing output-length estimator.
4. **Semantic features**: embedding the task text into a semantic space where pro-necessary tasks cluster together. This requires an embedding model.

The threshold sweep shows that if the model had slightly higher probability for the pro-necessary cases (8.1% → 10%+), it would catch them with 0% waste. The signal is there but weak. Richer features would strengthen it.

v0.17.0 establishes the evaluation infrastructure: dataset partitioning, label generation, model training, policy comparison, and threshold selection. The infrastructure is correct even though the current features are insufficient. Expanding the dataset and adding richer features is the v0.17.1+ path.

### What v0.17.1 adds

Shadow mode: run the learned router alongside the heuristic router, recording what it would have selected without controlling execution. This accumulates the paired outcome data needed to train with richer features and expand the dataset beyond 30 examples. The shadow router records its prediction and confidence, and the actual outcome (from whichever model the heuristic router selected) is joined to the shadow prediction for offline analysis.
