# Agent Note: v0.17.3 Forensic Features and Reactive Escalation Study

Status: implemented

English | [中文](2026-08-25-v0173-forensic-features-and-reactive-escalation.zh.md)

## Problem

The frozen v0.17.2 benchmark contains 100 Flash/Pro pairs but only six raw Flash-fail/Pro-pass labels. A nonnegative learned threshold misses all held-out rescues, while lowering the threshold degenerates toward Pro-only cost. The raw labels also combine model failures with verifier artifacts, and the frozen dollar metrics use a superseded flat pricing registry despite the calls occurring during a peak billing window.

## Decision

v0.17.3 treats verified failure as the stronger near-term escalation signal and keeps pre-routing learning as offline research. It freezes v0.17.2 as `paired-v4-100-v1`, audits every rescue label, adds the separate `workload-v2` feature schema, compares weighted logistic regression with gradient-boosted decision stumps, corrects pricing by durable event timestamp, and simulates task-level verification-triggered escalation.

**No learned routing policy qualified for production authority. Learned routing remains shadow-only. The reactive Flash-to-Pro policy is also an offline study and does not control runtime execution.**

The existing deterministic ordering remains unchanged:

```text
Manual selection
       ↓
durable authority
       ↓
hard policy constraints
       ↓
context/provider availability
       ↓
authoritative heuristic router
```

The candidate reactive path is evaluated separately:

```text
TASK
  ↓
FLASH
  ↓
objective verification
  ├─ pass → DONE
  └─ fail → PRO
              ↓
        objective verification
          ├─ pass → DONE
          └─ fail → STOP
```

### Frozen baseline

`artifacts/reports/paired-v4-100-v1.manifest.json` pins the dataset ID, source commit, artifact SHA-256 hashes, task-ID partitions, feature/model versions, threshold, and held-out metrics. `verify-routing-dataset-freeze` runs in the static CI aggregate and rejects artifact, identity, or partition drift. Future experiments consume the frozen files rather than rewriting them.

### Rescue forensics

The six raw Pro-necessary labels resolve to three genuine rescues, one ambiguous strict-output case, and two verifier artifacts. Five of the six prompts have an identical second iteration where Flash passes, so deterministic pre-routing features cannot explain the observed label by task structure alone.

| Task | Label validity | Failure mechanism |
|---|---|---|
| constraints-email/1 | genuine | extraneous output, word-limit violation, and incorrect terminal literal |
| json-filter/1 | genuine | wrong projection schema and fenced output |
| synthesis-oauth/1 | genuine | four required output units collapsed into one sentence |
| constraints-table/1 | ambiguous | correct table followed by a restatement that breaks exact multiplicity |
| plan-api/1 | verifier artifact | bold Markdown numbering not recognized |
| plan-migration/1 | verifier artifact | top-level Step headings not counted; nested numbers accidentally pass Pro |

Verifier artifacts are excluded from the direct Pro-necessity target. The ambiguous case is retained in outcome-class analysis but excluded from binary Pro-necessity training.

### WorkloadFeaturesV2

`analyzeTaskStructure()` produces `featureVersion: 'workload-v2'` without invoking a model. The schema records pre-routing context counts, explicit and nested constraints, strict/no-extraneous format requirements, expected cardinality, transformation type and operation count, semantic-preservation requirements, source/output structure, requested output representation, and deterministic task-category one-hot scores. It is separate from the v1 numeric vector; fields are not appended silently.

`deriveBayesianHistoricalFeatures()` consumes completed earlier outcomes only. Caller-supplied global priors and prior strength shrink sparse same-bucket rates for Flash pass, Pro pass, Pro rescue, Flash repair, and cost difference. Training history grows within training, validation begins from training history, and test begins from training plus validation history.

### Richer targets and models

The evaluation preserves `flash_verified`, `pro_verified`, `delta_quality`, `flash_cost`, `pro_cost`, `delta_cost`, `pro_necessary`, and the full outcome class. Flash-better and both-fail examples remain separate. Weighted logistic regression and gradient-boosted decision stumps predict Flash/Pro success independently; linear regression and boosted regression predict peak-schedule model cost.

Only three audited genuine rescues remain: two in training, one in validation, and none in test. Held-out ProNecessity recall is therefore not estimable for either model family. Workload-v2 supports interpretable ablation and feature-importance analysis but does not qualify a learned policy.

### Timestamp-resolved pricing

The pricing registry retains the historical flat schedule before `2026-08-16T16:00:00Z` and resolves peak/off-peak entries afterward from `ModelUsageRecord.time`. Peak windows are 01:00-04:00 and 06:00-10:00 UTC. The v0.17.2 calls occurred during the 06:00-10:00 peak window.

Current rates per million tokens are:

| Model | Band | Cache-hit input | Cache-miss input | Output |
|---|---|---:|---:|---:|
| Flash | off-peak | $0.007 | $0.22 | $0.66 |
| Flash | peak | $0.014 | $0.44 | $1.32 |
| Pro | off-peak | $0.022 | $0.66 | $1.98 |
| Pro | peak | $0.044 | $1.32 | $3.96 |

The frozen v0.17.2 reports remain unchanged as historical artifacts; v0.17.3 reprices their immutable token buckets under both current bands.

## Measured reactive economics

The primary simulation uses 50 task classes, iteration 1 as the initial attempt, forensic-audited verifier labels, and peak prices.

| Policy | Verified | Cost/verified | Total cost | Escalation | Pro utilization |
|---|---:|---:|---:|---:|---:|
| Flash-only | 88.0% | $0.004683 | $0.206064 | 0% | 0% |
| Pro-only | 94.0% | $0.013005 | $0.611236 | 0% | 100% |
| Flash then Pro after failure | 96.0% | $0.005819 | $0.279291 | 12% | 10.7% |
| Flash retry then Pro proxy | 98.0% | $0.004386 | $0.214891 | 2% | 1.8% |

Pro-only costs 2.78 times Flash-only per verified task. Flash-then-Pro costs 55.3% less than Pro-only while exceeding its observed verified-success point estimate; it costs 24.2% more than Flash-only because failed Flash attempts remain in task cost.

The retry row is an independent repeated-prompt proxy, not an evidence-conditioned repair trajectory. It cannot qualify a production repair policy. A real repair attempt must receive the Flash diff/output, failed criteria, test output, error fingerprint, and relevant context, then record all three stages under one task outcome.

## Alternatives considered

### Continue tuning the pre-routing threshold

No nonnegative threshold satisfies success and rescue-recall constraints. Negative thresholds select Pro even when predicted Pro success is lower and collapse toward Pro-only waste. Threshold tuning cannot create information absent from the feature vector or repair noisy labels.

### Train on all six raw rescue labels

Two labels are verifier artifacts and one is ambiguous. Treating them as genuine positives teaches the router to predict verifier syntax rather than model value. Audited validity remains separate from raw outcome classification.

### Make Pro the default worker

Pro-only improves observed verification but costs 2.78 times Flash-only per verified task and uses Pro on every task. Verification-triggered escalation reaches a higher point estimate with 10.7% Pro utilization in this sample.

### Treat the independent retry proxy as a production result

The second Flash run does not receive failure evidence and is affected by warm cache state. Its result estimates repeated-prompt economics only. Runtime repair requires a joined evidence-conditioned trajectory.

### Add embeddings before structural analysis

The audited failures expose concrete missing measurements: constraint count, exact terminal text, no-extraneous output, projection operations, and output cardinality. Deterministic V2 features encode these facts directly and remain interpretable. Semantic embeddings remain deferred until a larger audited corpus shows residual value.

### Declare a durable shadow event before runtime integration

No runtime producer exists. Offline report types do not expand the session protocol. A durable event is introduced only with the real emitter, ignorable append semantics, persistence catalog, and SDK projections.

## Consequences

The repository now distinguishes raw verifier outcomes, audited routing labels, and same-prompt stochastic disagreement. The result reduces the usable rescue set from six to three and prevents the current corpus from supporting a learned-routing claim.

Timestamp-resolved pricing makes historical and current economics reproducible. The reactive study identifies verification-triggered Flash-to-Pro escalation as the strongest candidate policy, but runtime authority remains unchanged.

Promotion evidence requires a real staged execution path with one Flash attempt, at most one evidence-conditioned Flash repair, at most one Pro repair, hard verification after each stage, failure-fingerprint loop protection, and complete task-level cost/latency attribution. Learned-routing research requires 30-50 audited genuine rescues and an untouched natural-distribution test set before recall or economic promotion can be measured credibly.
