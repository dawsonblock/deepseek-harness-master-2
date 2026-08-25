# Agent Note: v0.17.1 Shadow-Mode Infrastructure — Richer Features and Multi-Target Model

Status: implemented

English | [中文](2026-08-25-v0171-shadow-mode-infrastructure.zh.md)

## Problem

The v0.17.0 offline evaluation proved the learning loop works end-to-end but identified that the 7 complexity-scorer features are insufficient to predict Pro-necessity. The 3 pro-necessary cases (`structured-transform`, `factual-explain`) have zero complexity signals. No amount of threshold tuning on the existing feature space can separate them from the 25 cases where Pro is unnecessary. The dataset (30 pairs) is also too small to train a meaningful router.

## Decision

Ship the shadow-mode infrastructure for v0.17.1: richer pre-routing features, a deterministic task-type classifier, a multi-target model, and a shadow evaluation framework. The heuristic router retains control; the learned router runs alongside it, recording predictions for offline evaluation. No live deployment of the learned router.

### Shadow-mode architecture

```
                    LIVE TASK
                       |
                       v
              Pre-routing features
                 /     |      \
                /      |       \
        structural   semantic   history
                \      |       /
                 \     |      /
                       v
               Learned predictor
                       |
              +--------+--------+
              v                 v
        shadow choice      heuristic choice
                               |
                               v
                         ACTUAL EXECUTION
                               |
                               v
                         RoutingOutcome
                               |
                               v
                   shadow-policy evaluator
```

The learned router predicts; the heuristic router controls. Every prediction is recorded durably via `model/shadow-routing-prediction` session events, joined to actual outcomes via `routingDecisionId` and execution coordinates.

### Richer pre-routing features (25 features, 4 families)

1. **Complexity** (7): existing heuristic scorer signals — `explicitReasoningRequests`, `mathMarkers`, `architectureMarkers`, `codeBlocks`, `lengthBands`, `complexityScore`, `promptLength`
2. **Structural** (11): `estimatedInputTokens`, `messageCount`, `toolSchemaCount`, `attachedFileCount`, `codeBlockCount`, `structuredDataSize`, `requestsStructuredOutput`, `jsonTransformationIndicator`, `multiFileIndicator`, `toolRequirementIndicator`, `verificationCriterionCount`
3. **Categorical** (1): `taskType` from a deterministic classifier with `expectsProAdvantage` flag
4. **Historical** (6): `flashSuccessRateByTaskType`, `proSuccessRateByTaskType`, `flashToProRescueRate`, `recentFlashFailureRate`, `historicalCostDifference`, `historicalSampleCount`

Historical features are zero-initialized for the frozen dataset. They become informative once shadow mode accumulates paired outcomes across sessions.

### Deterministic task-type classifier

A keyword-and-structural classifier maps turn text to one of 9 task types: `factual-explain`, `structured-transform`, `reasoning-proof`, `code-edit`, `debugging`, `planning`, `tool-heavy`, `long-context`, `simple-factual`. No embedding model — the classifier is cheap, deterministic, and tests how much value categorical features provide before adding semantic features.

The classifier correctly identifies `structured-transform` as expecting Pro advantage — the task type the v0.16.0 benchmark showed is Pro-necessary. This is a real improvement over v0.17.0, which had zero signal for these tasks.

### Multi-target model

Three separate logistic regression models trained on the same features:

- P(Flash passes): predicts Flash verified success
- P(Pro passes): predicts Pro verified success
- Expected cost delta: predicts Pro - Flash cost difference

The routing decision is a threshold on the utility difference: choose Pro when `P(Pro passes) - P(Flash passes) >= threshold`. This is closer to the economic question than a single opaque classification.

### Shadow evaluation framework

The metric hierarchy, in priority order:

1. Verified success rate — primary constraint
2. Cost per verified task — primary optimization target
3. ProNecessity recall — don't miss tasks that genuinely need Pro
4. ProWasteRate — minimize unnecessary Pro
5. Repair rate
6. Median/p90 latency
7. Pro utilization

### Release gate for promoting learned router

The learned router replaces the heuristic router only when:

| Criterion | Target |
|---|---|
| Verified success | no material degradation |
| Cost per verified task | >=15-20% improvement |
| ProNecessity recall | >=90% |
| ProWasteRate | materially lower |
| Shadow sample size | large enough for confidence intervals |

All criteria are "insufficient data" at 30 pairs. v0.17.1 target: 100-200 labeled tasks. v0.17.2 target: 500+ tasks.

## Measured results

### Test partition (3 task classes, 6 examples)

| Policy | Verified | Cost/verified | ProNecessity recall | ProWaste rate | Pro util |
|---|---:|---:|---:|---:|---:|
| Flash-only | 50.0% | $0.001054 | 0% | 0% | 0% |
| Pro-only | 66.7% | $0.002248 | 100% | 33% | 100% |
| Heuristic router | 50.0% | $0.001054 | 0% | 0% | 0% |
| Learned router | 50.0% | $0.001054 | 0% | 0% | 0% |

The multi-target model assigns P(Flash) == P(Pro) for all test tasks. With 18 training examples, the two logistic regressions converge to similar weights — the model cannot differentiate Flash from Pro pass probability. The task-type classifier correctly identifies `structured-transform` as expecting Pro advantage, but the model can't use this signal because the two targets are identical.

### Task-type classification

The deterministic classifier correctly identifies:
- `structured-transform` as `structured-transform` (expects Pro: yes)
- `reasoning-proof` as `reasoning-proof` (expects Pro: yes)
- `factual-explain` as `factual-explain` (expects Pro: yes)
- `code-edit` as `code-edit` (expects Pro: no)
- `arithmetic` as `simple-factual` (expects Pro: no)

Some misclassifications: `debug-off-by-one` classified as `unknown`, `verify-algorithm` classified as `factual-explain`, `long-context-summary` classified as `planning`. These are edge cases the deterministic classifier misses — semantic embeddings would fix them.

## Alternatives considered

### Why not deploy the learned router immediately?

With 30 examples and P(Flash) == P(Pro) on all test tasks, the learned router provides no improvement over Flash-only. Deploying it would be deploying noise. The release gate requires >=15-20% CPT improvement and >=90% ProNecessity recall — neither is achievable at this sample size.

### Why not add semantic embeddings now?

The user's priority order is correct: structural features first, categorical features second, historical features third, semantic embeddings only if simpler features leave substantial unexplained Pro-necessity. The deterministic task-type classifier already identifies the Pro-necessary task types. Adding embeddings before exhausting simpler features would add complexity without proven value.

### Why not use a joint model for P(Flash) and P(Pro)?

A joint model capturing the correlation between Flash and Pro pass probabilities would be richer than two independent logistic regressions. But with 18 training examples, a joint model would overfit. The independent models are the appropriate complexity for this sample size. A joint model is a v0.18+ concern after dataset expansion.

### Why not cross-validate?

Leave-one-task-out cross-validation on 15 task classes would give 15 folds, but each fold trains on 14 tasks and tests on 1 — high variance with 2 examples per task. The single 60/20/20 split is more interpretable. Cross-validation should be added when the dataset expands to 100+ tasks.

## Consequences

The shadow-mode infrastructure is complete: richer features (25 vs 7), multi-target model, deterministic task-type classifier, shadow event type, and evaluation framework with the metric hierarchy. The task-type classifier correctly identifies the Pro-necessary task types — the signal that was completely missing in v0.17.0.

The dataset remains the bottleneck. With 30 pairs, the multi-target model converges to P(Flash) == P(Pro) because it cannot learn the difference from 18 training examples. The infrastructure is ready for 100-200 tasks; the dataset is not.

The `model/shadow-routing-prediction` event type is declared but not yet wired into the router plugin. Wiring it requires the router to call the learned predictor before making its own decision, record the shadow prediction, then proceed with the heuristic choice. This is a small change to the router's `agent/request` listener but requires the model to be loaded from a serialized state file, which does not exist yet.

### What v0.17.2 adds

1. **Dataset expansion to 500+ tasks**: requires live API calls with rotated credentials. Oversample hard cases: structured transformations, ambiguous factual synthesis, multi-constraint tasks, multi-file edits, debugging with hidden root cause, verification-heavy tasks, long-context tasks, failed-Flash repair cases.

2. **Wire shadow prediction into the router**: load the trained model from a serialized state file, call `predict()` before the heuristic decision, emit `model/shadow-routing-prediction`, then proceed with the heuristic choice.

3. **Historical feature accumulation**: compute Flash/Pro success rates by task type from past session outcomes. These features become informative once shadow mode has accumulated paired data across sessions.

4. **Cross-validation**: once the dataset exceeds 100 tasks, switch from single 60/20/20 split to k-fold cross-validation stratified by task class.

5. **Joint model**: once the dataset exceeds 200 tasks, train a joint model capturing P(Flash) and P(Pro) correlations rather than two independent logistic regressions.
