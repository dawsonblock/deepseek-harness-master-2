# Agent Note: Economics and Routing Join — v0.16.0-alpha.2

Status: implemented

English | [中文](2026-08-23-economics-and-routing-join.zh.md)

## Problem

The durable model-selection control plane (v0.15.5) records which model was selected and why, but does not record what that selection consumed or cost. Token usage lives on `assistant/message.usage`, which is a transcript event — it exists only for successful assistant messages. A retry that consumed provider tokens but failed before producing a final message leaves no accounting trace. There is no pricing registry, no cost calculation, and no way to join a routing decision to its economic outcome.

The v0.16.0-alpha.1 accounting core established the canonical `TokenUsage` vocabulary (cache hit, cache miss, total, provenance, request ID, routing correlation) and the DeepSeek provider normalizer with invariant validation. Alpha.2 builds the economics layer on top of that vocabulary: routing-decision identity propagation, a durable per-attempt accounting event, versioned pricing, cost calculation, and aggregation by routing decision.

## Decision

Five decisions, each elaborated below:

1. **`routingDecisionId` propagates through the execution context as a retrospective log scan**, not request-scoped metadata. The `agent/request` waterfall returns `LlmCallConfig`, not metadata, so the step loop finds the latest `model/routing-decision` for the current turn/step from the session log and stamps it onto `model/request` and `assistant/message` usage.
2. **`model/usage` is the canonical accounting event stream**, emitted once per paid attempt regardless of turn success. `assistant/message.usage` remains as a backward-compatible transcript projection. All pricing, aggregates, and future outcome joins fold `model/usage`, never `assistant/message.usage`.
3. **Pricing is a versioned registry separate from token usage.** `ModelPricing` carries `observedAt` (when the repository pinned the price) and optional `effectiveFrom` (when the provider says the price took effect). DeepSeek does not publish an effective-from date, so the V4 snapshot uses `observedAt` only.
4. **Cost calculation uses the disjoint convention: cache-hit + cache-miss + output.** It never charges from `totalTokens` (cache-hit and cache-miss have different prices) and never adds `reasoningTokens` separately (DeepSeek bills reasoning as part of completion usage). Absent cache fields produce a `conservative-estimate` confidence label.
5. **Aggregation is a pure fold over immutable records.** No mutable session counters. `usageBySession`, `usageByTurn`, `usageByModel`, `usageByRoutingDecision`, and `routingDecisionAccounting` derive views from the `model/usage` event stream.

### Routing-decision join

The router hooks `agent/request`, calls `decideRoute`, appends `model/routing-decision` with a deterministically generated `routingDecisionId`, and returns the selected `LlmCallConfig`. The step loop's `latestRoutingDecisionId` helper scans the session log backwards for the latest routing decision matching the current turn/step.

Invariant: for one (sessionId, turn, step), there is at most one effective routing decision for the model request being constructed. Retries reuse the same routing decision — `routingDecisionId` identifies route selection, while `attempt` identifies provider execution.

This is a retrospective lookup rather than true request-scoped provenance. A future refactor could replace the log scan with request-scoped execution metadata on the waterfall return value, but only if the router is ever allowed to reroute between retry attempts (which would require `attempt` in the routing decision identity). The current design is sufficient because retries today always reuse the same routing decision.

### `model/usage` event

The new ignorable `model/usage` session event records per-attempt provider token accounting:

```
turn, step, attempt, provider, model, usage: TokenUsage, routingDecisionId?
```

It is emitted in three paths:
- Success: after the stream completes and before `assistant/message`.
- Error/aborted finish: after the finish is classified as error or aborted, before the retry decision.
- Interrupted stream: in the catch block when the signal was aborted, before the interrupted `assistant/message`.

It is NOT emitted when the adapter reports no usage (e.g. stream aborted before the final usage chunk). This prevents fabricated provider records.

`assistant/message.usage` remains for backward-compatible UI projection and is stamped with `routingDecisionId` via the `usageSpread` helper. New accounting code folds `model/usage` exclusively.

### Pricing registry

`ModelPricing` distinguishes `observedAt` from `effectiveFrom`:

```typescript
interface ModelPricing {
  provider: string
  model: string
  currency: 'USD'
  version: string
  observedAt: string
  effectiveFrom?: string
  perMillion: { cacheHitInput, cacheMissInput, output }
}
```

DeepSeek's current page lists prices but does not publish an official effective-from date. The repository snapshot `DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23` records `observedAt: '2026-08-23'` with `effectiveFrom` absent. The version string `deepseek-v4-usd-observed-2026-08-23` encodes the observation date, not an effective date.

DeepSeek V4 pricing (per million tokens, USD):

| Model | Cache-hit input | Cache-miss input | Output |
|---|---|---|---|
| deepseek-v4-flash | $0.0028 | $0.14 | $0.28 |
| deepseek-v4-pro | $0.003625 | $0.435 | $0.87 |

### Cost calculation

`calculateCost(usage, pricing)` produces `CalculatedModelCost` with per-component breakdown and confidence:

```
C = (H/1M) * P_hit + (M/1M) * P_miss + (O/1M) * P_out
```

where H = `cacheReadTokens`, M = `cacheMissTokens ?? inputTokens`, O = `outputTokens`.

Confidence is `'exact'` only when cache decomposition is present AND `source === 'provider'`. Legacy usage without cache fields, estimated usage, and provider usage missing cache decomposition all produce `'conservative-estimate'`.

### Aggregation

Pure folds over immutable `model/usage` records:

- `extractUsageRecords(events, sessionId)` — projects `model/usage` events to `ModelUsageRecord`.
- `usageBySession` — all records in one totals object.
- `usageByTurn` — grouped by turn number.
- `usageByModel` — grouped by `provider/model`.
- `usageByRoutingDecision` — grouped by `routingDecisionId`, excluding manual selection.
- `routingDecisionAccounting` — per-decision view with model list, attempt count, and aggregated totals.

`UsageTotals` includes `requests`, token sums (input, cacheRead, cacheMiss, output, reasoning, total), `cacheHitRate`, `costUsd`, and `exactCosts`/`estimatedCosts` counts.

## Alternatives considered

### Why not fold `assistant/message.usage` for accounting?

A retry that consumed provider tokens but failed before producing a final assistant message leaves no `assistant/message` event. Folding `assistant/message.usage` would lose paid attempts. The invariant test proves: 2 `model/usage` events, 1 `assistant/message`, accounting total = attempt1 + attempt2.

### Why not put pricing in the model registry?

Model capability and price lifecycle are different things. DeepSeek explicitly warns that prices can change. The model registry describes what a model can do; the pricing registry describes what it costs under a specific observation snapshot. Coupling them would force a model registry update every time prices change.

### Why not carry `routingDecisionId` through the waterfall return value?

The `agent/request` waterfall contract returns `LlmCallConfig`. Changing that contract to return `{ config, executionMetadata }` would be an invasive refactor touching every waterfall listener. The retrospective log scan is sufficient under the current invariant that retries reuse the same routing decision. The architectural note on `latestRoutingDecisionId` documents the limitation and the condition under which a refactor would be needed.

### Why not use `effectiveFrom` for the pricing snapshot?

DeepSeek's current page gives prices but does not establish an official effective-from date. Recording `effectiveFrom: '2026-08-23'` would imply the provider published that date, which is not defensible. `observedAt` records when the repository pinned the price; `effectiveFrom` is reserved for when a provider explicitly publishes one.

## Consequences

The routing/cost join is now reliable. For every routing decision, the harness can determine what model ran, what it consumed, what it cost, and under which pricing version. The `confidence` label prevents historical records from masquerading as provider-exact economics.

The `model/usage` event is ignorable and persists through JSONL and SQLite. Snapshot refresh updated golden files to include `model/usage` events; replay passes with only pre-existing `durationMs` timing variance failures (documented in the v0.15.5 baseline report).

The `console.warn` diagnostic for `TOKEN_USAGE_INCONSISTENT` (alpha.1) remains as a low-blast-radius alpha solution. It should move to the repository's structured diagnostic/telemetry system during RC1, carrying provider, model, requestId, invariant, and raw values without polluting stderr or snapshots.

The token-meter suite is fully green (55/55). The pre-existing `reasoningTokens: 0` assertion mismatch was resolved by updating the stale test expectation: `undefined` means the provider did not report reasoning usage; `0` means the provider explicitly reported zero. The source correctly emits `reasoningTokens: 0` for non-reasoning messages.

### What RC1 adds

The next milestone is not token counting by itself, but verified outcome per dollar:

```
model/usage → routingDecisionId → CalculatedModelCost → outcome-verification receipt → RoutingOutcome
```

That record — routing decision, model, tokens, cost, repairs, verified result — is what makes the router experimentally measurable rather than heuristic.
