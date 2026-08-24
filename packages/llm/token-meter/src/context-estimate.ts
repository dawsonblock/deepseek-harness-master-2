/**
 * Context estimation vocabulary and budget evaluation.
 *
 * The estimator contract (`TokenEstimate`, `EstimatorIdentity`,
 * `EstimatePrecision`, `TokenEstimateResult`, `ProviderTokenEstimator`,
 * `TokenizerBackend`) lives in `dsh-llm`; this module re-exports those types
 * for backward compatibility and provides budget evaluation, workload
 * features, estimation error, and aggregator functions.
 *
 * These types are semantically separate from `TokenUsage`:
 * - `TokenEstimate` is a prediction before execution.
 * - `TokenUsage` is observed provider accounting after execution.
 *
 * Estimated values must never enter provider-authoritative cost totals.
 *
 * @module @deepseek-ai/dsh-token-meter/context-estimate
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {
  TokenEstimate,
  EstimatorIdentity,
  EstimatePrecision,
  ContextUtilization,
} from '@deepseek-ai/dsh-llm'
import { estimateMessage } from './estimate.ts'

// Re-export the estimator vocabulary from the contract in dsh-llm.
export type {
  TokenEstimate,
  EstimatorIdentity,
  EstimatePrecision,
  TokenEstimateResult,
  ProviderTokenEstimator,
  TokenizerBackend,
  ContextBudgetPolicy,
  ContextStatus,
  ContextUtilization,
} from '@deepseek-ai/dsh-llm'
export {
  DEFAULT_CONTEXT_BUDGET_POLICY,
  evaluateContextBudget,
} from '@deepseek-ai/dsh-llm'

/** Context workload features captured at routing decision time. These are
 * pre-decision features for future learned routing. */
export interface ContextWorkloadFeatures {
  estimatedInputTokens: number
  contextWindowTokens: number
  requestedOutputTokens: number
  remainingContextTokens: number
  contextUsageRatio: number
  estimatorId: string
  estimatorVersion: string
}

/** One estimate-vs-actual measurement. The original estimate is not mutated. */
export interface TokenEstimationError {
  estimated: number
  actual: number
  absoluteError: number
  relativeError: number
  estimatorId: string
  estimatorVersion: string
  provider: string
  model: string
  /** Precision class of the estimator (`'tokenizer'` or `'heuristic'`). */
  precision?: string
  /** Turn coordinate for joining to routing decisions. */
  turn?: number
  /** Step coordinate for retry isolation. */
  step?: number
  /** Attempt coordinate for retry isolation. */
  attempt?: number
  /** Routing decision id, when a router was active. */
  routingDecisionId?: string
  /** True when the estimate was lower than the actual (underestimate). */
  underestimated?: boolean
}

/** Aggregated estimator quality across many measurements. */
export interface EstimatorQuality {
  count: number
  meanAbsoluteError: number
  medianRelativeError: number
  p90RelativeError: number
  p95RelativeError: number
  p99RelativeError: number
  /** Fraction of measurements where the estimate was below actual. */
  underestimateRate: number
  /** Fraction of measurements where the estimate was above actual. */
  overestimateRate: number
}

/** Options for {@link estimateRequestInput}. */
export interface EstimateRequestInputOptions {
  /** Estimator identity to stamp on the result. */
  estimator: EstimatorIdentity
  /** Precision class of the estimate. */
  precision: EstimatePrecision
}

/**
 * Estimate input tokens for one assembled LLM request using the existing
 * fixed-density heuristic. The estimate covers system prompt, messages, and
 * tool schemas — all model-visible input.
 *
 * @param request - the fully assembled request.
 * @param options - estimator identity and precision.
 * @returns a `TokenEstimate` with `source: 'estimated'`.
 */
export function estimateRequestInput(
  request: GenerateOptions,
  options: EstimateRequestInputOptions,
): TokenEstimate {
  let tokens = 0
  if (request.system !== undefined && request.system.length > 0) {
    tokens += Math.ceil(request.system.length / 4) + 4
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    tokens += Math.ceil(JSON.stringify(request.tools).length / 4) + 4
  }
  for (const message of request.messages) {
    tokens += estimateMessage(message)
  }
  return {
    tokens,
    source: 'estimated',
    estimator: options.estimator,
    precision: options.precision,
  }
}

/**
 * Derive a context workload feature snapshot from a utilization.
 *
 * @param utilization - the evaluated context budget.
 * @param estimate - the originating estimate for estimator provenance.
 * @returns pre-decision context features for routing.
 */
export function deriveContextWorkloadFeatures(
  utilization: ContextUtilization,
  estimate: TokenEstimate,
): ContextWorkloadFeatures {
  return {
    estimatedInputTokens: utilization.estimatedInputTokens,
    contextWindowTokens: utilization.contextWindowTokens,
    requestedOutputTokens: utilization.reservedOutputTokens,
    remainingContextTokens: utilization.remainingTokens,
    contextUsageRatio: utilization.usageRatio,
    estimatorId: estimate.estimator.id,
    estimatorVersion: estimate.estimator.version,
  }
}

/**
 * Derive one estimate-vs-actual measurement. The original estimate is not
 * mutated.
 *
 * @param estimate - the preflight estimate.
 * @param actualPromptTokens - provider-reported `prompt_tokens`.
 * @param provider - provider route id.
 * @param model - model id.
 * @returns a `TokenEstimationError` with absolute and relative error.
 */
export function deriveEstimationError(
  estimate: TokenEstimate,
  actualPromptTokens: number,
  provider: string,
  model: string,
): TokenEstimationError {
  const absoluteError = Math.abs(estimate.tokens - actualPromptTokens)
  const relativeError = actualPromptTokens > 0
    ? absoluteError / actualPromptTokens
    : 0
  return {
    estimated: estimate.tokens,
    actual: actualPromptTokens,
    absoluteError,
    relativeError,
    estimatorId: estimate.estimator.id,
    estimatorVersion: estimate.estimator.version,
    precision: estimate.precision,
    provider,
    model,
    underestimated: estimate.tokens < actualPromptTokens,
  }
}

/** Percentile helper: returns the value at the given percentile from a
 * sorted ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  // oxlint-disable-next-line typescript/no-non-null-assertion -- length === 1 guarantees index 0
  if (sorted.length === 1) return sorted[0]!
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  // oxlint-disable-next-line typescript/no-non-null-assertion -- lo is a valid index
  if (lo === hi) return sorted[lo]!
  const weight = rank - lo
  // oxlint-disable-next-line typescript/no-non-null-assertion -- lo and hi are valid indices
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight
}

/** Median helper for a sorted ascending array. */
function median(sorted: readonly number[]): number {
  return percentile(sorted, 50)
}

/**
 * Aggregate estimator quality across many measurements.
 *
 * @param errors - one measurement per estimate-vs-actual pair.
 * @returns aggregated quality including percentiles and under/overestimate rates.
 */
export function aggregateEstimatorQuality(
  errors: readonly TokenEstimationError[],
): EstimatorQuality {
  const count = errors.length
  if (count === 0) {
    return {
      count: 0,
      meanAbsoluteError: 0,
      medianRelativeError: 0,
      p90RelativeError: 0,
      p95RelativeError: 0,
      p99RelativeError: 0,
      underestimateRate: 0,
      overestimateRate: 0,
    }
  }
  const absoluteErrors = errors.map(e => e.absoluteError).sort((a, b) => a - b)
  const relativeErrors = errors.map(e => e.relativeError).sort((a, b) => a - b)
  const underestimates = errors.filter(e => e.estimated < e.actual).length
  const overestimates = errors.filter(e => e.estimated > e.actual).length
  return {
    count,
    meanAbsoluteError: absoluteErrors.reduce((sum, v) => sum + v, 0) / count,
    medianRelativeError: median(relativeErrors),
    p90RelativeError: percentile(relativeErrors, 90),
    p95RelativeError: percentile(relativeErrors, 95),
    p99RelativeError: percentile(relativeErrors, 99),
    underestimateRate: underestimates / count,
    overestimateRate: overestimates / count,
  }
}

/** A preflight estimate record extracted from session events. */
interface PreflightRecord {
  turn: number
  step: number
  attempt: number
  provider: string
  model: string
  estimatedInputTokens: number
  estimatorId: string
  estimatorVersion: string
  routingDecisionId?: string
}

/** A usage record extracted from session events. */
interface UsageRecord {
  turn: number
  step: number
  attempt: number
  provider: string
  model: string
  inputTokens: number
  routingDecisionId?: string
}

/** Result of joining estimate and actual usage, including mismatch detection. */
export type TokenEstimationErrorProjection =
  | { kind: 'joined'; error: TokenEstimationError }
  | { kind: 'routing-mismatch'; turn: number; step: number; attempt: number; estimateRoutingId: string; usageRoutingId: string }
  | { kind: 'missing-actual'; turn: number; step: number; attempt: number }
  | { kind: 'missing-estimate'; turn: number; step: number; attempt: number }

/**
 * Derive estimation errors by joining preflight estimates to actual usage
 * records using exact `(turn, step, attempt)` coordinates.
 *
 * Routing-decision identity is validated: when both the estimate and the
 * usage carry a `routingDecisionId` and they differ, the pair is classified
 * as a routing mismatch rather than joined. This prevents unrelated records
 * from being joined across routing decisions.
 *
 * @param events - the full session event stream.
 * @returns one projection per preflight estimate, plus mismatch and missing records.
 */
export function deriveTokenEstimationErrors(
  events: readonly { type: string; data: Record<string, unknown> }[],
): TokenEstimationErrorProjection[] {
  const preflights: PreflightRecord[] = []
  const usages: UsageRecord[] = []
  for (const event of events) {
    if (event.type === 'model/context-preflight') {
      const d = event.data
      if (d.phase !== 'post-routing') continue
      preflights.push({
        turn: d.turn as number,
        step: d.step as number,
        attempt: d.attempt as number,
        provider: d.provider as string,
        model: d.model as string,
        estimatedInputTokens: d.estimatedInputTokens as number,
        estimatorId: d.estimatorId as string,
        estimatorVersion: d.estimatorVersion as string,
        ...d.routingDecisionId === undefined ? {} : { routingDecisionId: d.routingDecisionId as string },
      })
    } else if (event.type === 'model/usage') {
      const d = event.data
      usages.push({
        turn: d.turn as number,
        step: d.step as number,
        attempt: d.attempt as number,
        provider: d.provider as string,
        model: d.model as string,
        inputTokens: (d.usage as { inputTokens: number }).inputTokens,
        ...d.routingDecisionId === undefined ? {} : { routingDecisionId: d.routingDecisionId as string },
      })
    }
  }
  const results: TokenEstimationErrorProjection[] = []
  for (const pf of preflights) {
    const usage = usages.find(u =>
      u.turn === pf.turn && u.step === pf.step && u.attempt === pf.attempt,
    )
    if (usage === undefined) {
      results.push({ kind: 'missing-actual', turn: pf.turn, step: pf.step, attempt: pf.attempt })
      continue
    }
    if (pf.routingDecisionId !== undefined && usage.routingDecisionId !== undefined
      && pf.routingDecisionId !== usage.routingDecisionId) {
      results.push({
        kind: 'routing-mismatch',
        turn: pf.turn,
        step: pf.step,
        attempt: pf.attempt,
        estimateRoutingId: pf.routingDecisionId,
        usageRoutingId: usage.routingDecisionId,
      })
      continue
    }
    const error = deriveEstimationError(
      { tokens: pf.estimatedInputTokens, source: 'estimated', estimator: { id: pf.estimatorId, version: pf.estimatorVersion }, precision: 'heuristic' },
      usage.inputTokens,
      pf.provider,
      pf.model,
    )
    results.push({
      kind: 'joined',
      error: {
        ...error,
        turn: pf.turn,
        step: pf.step,
        attempt: pf.attempt,
        ...pf.routingDecisionId === undefined ? {} : { routingDecisionId: pf.routingDecisionId },
      },
    })
  }
  for (const usage of usages) {
    const pf = preflights.find(p =>
      p.turn === usage.turn && p.step === usage.step && p.attempt === usage.attempt,
    )
    if (pf === undefined) {
      results.push({ kind: 'missing-estimate', turn: usage.turn, step: usage.step, attempt: usage.attempt })
    }
  }
  return results
}
