# Agent Note: v0.17.2 Expanded Shadow Qualification

Status: implemented

English | [中文](2026-08-25-v0172-expanded-shadow-qualification.zh.md)

## Problem

The 30-pair evaluation validates the measurement-to-learning path but contains only three Pro-necessary examples. Its cost target also applies logistic regression to a continuous dollar difference, so the reported cost predictions do not estimate `Pro cost - Flash cost`. The sample cannot establish a learned routing operating point or support promotion from shadow mode.

## Decision

The expanded qualification uses 100 paired examples from 50 task classes. Each task runs twice on Flash and Pro through the real harness provider, usage, pricing, and verification path, producing 200 model calls. The benchmark deliberately includes structured transformations, factual synthesis, multi-constraint output, code edits, debugging, verification-heavy analysis, long context, planning, and simple factual controls.

The model has three targets: logistic `P(Flash passes)`, logistic `P(Pro passes)`, and linear expected cost difference. Model version 2 distinguishes the continuous cost regression from the two probability models. The routing score remains `P(Pro passes) - P(Flash passes)`; candidate thresholds are nonnegative because a negative threshold can select Pro when the model predicts a lower Pro success probability.

Task classes do not cross the 30/10/10 train, validation, and test task partitions. Every category appears in each partition. Historical features use only completed earlier examples: training history grows within training, validation starts from training history, and test starts from training plus validation history. Current-task outcomes never enter their own feature vectors.

This decision partially supersedes the model implementation described by [v0.17.1 shadow-mode infrastructure](2026-08-25-v0171-shadow-mode-infrastructure.md): probability targets remain logistic, while expected cost difference is linear. The earlier note remains active because it owns the shadow prediction schema, feature families, and deterministic-control ordering. The [v0.17.0 offline evaluation](2026-08-25-v017-offline-evaluation-learned-router.md) remains the evidence that the original complexity features lack sufficient separation.

## Dataset and partitions

| Partition | Task classes | Paired examples | Pro-necessary |
|---|---:|---:|---:|
| Train | 30 | 60 | 3 |
| Validation | 10 | 20 | 1 |
| Test | 10 | 20 | 2 |

The complete dataset contains six Pro-necessary examples, four Flash-better examples, three both-fail examples, and 86 both-pass/Pro-more-expensive examples. Hard cases are overrepresented, so these counts measure the benchmark rather than production prevalence.

## Held-out result

| Policy | Verified success | Cost per verified task | ProNecessity recall | ProWasteRate | Pro utilization |
|---|---:|---:|---:|---:|---:|
| Flash-only | 85.0% | $0.000895 | 0% | 0% | 0% |
| Pro-only | 90.0% | $0.002329 | 100% | 80% | 100% |
| Heuristic router | 85.0% | $0.000895 | 0% | 0% | 0% |
| Learned router | 85.0% | $0.000895 | 0% | 0% | 0% |

The dollar values in this frozen record use the historical flat pricing snapshot. The [v0.17.3 forensic and reactive study](2026-08-25-v0173-forensic-features-and-reactive-escalation.md) preserves these artifacts and reprices their token buckets under the effective peak/off-peak schedule.

The validation sweep contains no nonnegative threshold that preserves heuristic verified success and reaches 90% ProNecessity recall. The fallback threshold is `0.2`, which minimizes cost among equally successful validation policies but selects no Pro examples. On held-out test data it reproduces Flash-only behavior and misses both Pro-necessary examples.

The held-out verified-success intervals remain wide: Flash/heuristic/learned 95% Wilson interval is 64.0-94.8%, while Pro-only is 69.9-97.2%. ProNecessity recall has only two held-out positives; even perfect recall would have a 34.2-100.0% interval. Point estimates cannot satisfy the promotion requirement.

## Promotion decision

The learned router remains shadow-only. It fails the ProNecessity recall requirement and provides no cost improvement over the heuristic router. The benchmark also remains below the sample size needed for narrow confidence intervals. Manual selection, authority rules, hard context constraints, provider availability, and the heuristic router continue to control execution.

Promotion requires all of these conditions on held-out or shadow counterfactual evidence:

1. No material verified-success degradation.
2. At least 15-20% lower cost per verified task than the heuristic router.
3. At least 90% ProNecessity recall.
4. Materially lower ProWasteRate.
5. Confidence intervals narrow enough to support the comparisons.

## Alternatives considered

### Use a negative threshold to recover ProNecessity recall

A threshold of `-0.2` catches the validation rescue but permits Pro when predicted Pro success is below predicted Flash success. On test it degenerates to Pro-only behavior with 80% ProWasteRate. Negative thresholds are diagnostic only and are not valid operating points.

### Promote the `0.2` fallback

The fallback matches Flash-only cost but misses every held-out Pro-necessary example. It demonstrates that the current model cannot satisfy both economic and reliability constraints; it is not a deployment candidate.

### Keep logistic regression for cost difference

Logistic output is bounded as a probability and does not represent a continuous dollar target. Linear regression preserves the meaning and scale of expected `Pro cost - Flash cost`.

### Add semantic embeddings before collecting more outcomes

The deterministic task classifier still leaves multi-constraint, long-context, and several verification tasks as `unknown` or misclassified. Embeddings may address that residual, but the present sample cannot distinguish feature insufficiency from label scarcity reliably. The simpler feature families remain the qualification baseline.

### Treat all 100 pairs as independent random examples

Two iterations of one task share prompt structure and verification criteria. Splitting iterations across partitions would leak task identity and inflate apparent generalization. Partition ownership stays at the task-class level.

## Consequences

The learning loop now includes a larger real-provider dataset, resumable collection, task-isolated partitions, past-only historical features, confidence intervals, and correctly typed regression targets. Focused tests pin continuous cost prediction and independent Flash/Pro success learning.

The negative result is stronger than threshold tuning: no valid threshold satisfies the validation success-and-recall constraints, and the held-out fallback misses both rescue cases. Learned routing remains non-authoritative.

The active evidence still has only six Pro-necessary pairs and two held-out positives. A 500-plus-task corpus with deliberate rescue-case sampling is required before promotion qualification. Semantic features become justified only if deterministic structural, categorical, and historical features remain insufficient at that scale.
