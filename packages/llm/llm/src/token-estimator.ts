/**
 * Token estimator capability contract: Service Definition for preflight input
 * token estimation.
 *
 * The contract lives in `dsh-llm` so the core runtime (`agent-loop`) depends on
 * the capability, not on the accounting implementation (`token-meter`). Provider
 * estimators (`llm-deepseek`) and the generic fallback (`token-meter`) register
 * with the resolver; the resolver owns the `tokenEstimator` service name.
 *
 * The estimator estimates usage; the model registry defines capacity. These
 * are separate concerns with separate sources of truth.
 *
 * @module @deepseek-ai/dsh-llm/token-estimator
 */

import type { GenerateOptions } from './types.ts'
import { Service } from '@deepseek-ai/cordis'

/** One estimator's identity, carried with every estimate for provenance. */
export interface EstimatorIdentity {
  /** Stable estimator id (e.g. `'deepseek-tokenizer'`, `'character-heuristic'`). */
  id: string
  /** Estimator version, for correlating accuracy across releases. */
  version: string
}

/** Precision class of an estimate. Tokenizer estimates are still estimates
 * until compared against returned `prompt_tokens`. */
export type EstimatePrecision = 'tokenizer' | 'heuristic'

/** A preflight token prediction for one assembled request. */
export interface TokenEstimate {
  /** Estimated input token count. */
  tokens: number
  /** Always `'estimated'`; distinguishes from provider `TokenUsage.source`. */
  source: 'estimated'
  /** Estimator identity for accuracy join and aggregation. */
  estimator: EstimatorIdentity
  /** Precision class of the estimate. */
  precision: EstimatePrecision
}

/** Result of an estimation attempt: either an estimate or an explicit
 * unavailable marker with a structured reason. */
export type TokenEstimateResult =
  | { available: true; estimate: TokenEstimate }
  | {
    available: false
    reason:
      | 'provider-estimator-unavailable'
      | 'provider-estimator-failed'
      | 'fallback-estimator-failed'
  }

/** A tokenizer backend supplying real token counts. Only a real backend
 * earns `precision: 'tokenizer'`; an arbitrary callback does not. */
export interface TokenizerBackend {
  /** Stable backend id (e.g. `'deepseek-offline-tokenizer'`). */
  id: string
  /** Pinned backend version or tokenizer hash, for provenance. */
  version: string
  /** Count tokens for one text string using the real tokenizer. */
  countTokens(text: string): Promise<number>
}

/**
 * Provider-specific token estimator. Providers register implementations with
 * the resolver rather than owning the `tokenEstimator` service name.
 */
export interface ProviderTokenEstimator {
  /** Provider route this estimator serves (e.g. `'deepseek-official'`). */
  readonly provider: string
  /** Estimator identity for provenance stamping. */
  readonly identity: EstimatorIdentity
  /** Precision class of this estimator. */
  readonly precision: EstimatePrecision
  /** Whether this estimator handles the given model id. */
  supports(model: string): boolean
  /** Estimate input tokens for one assembled request. */
  estimateInput(request: GenerateOptions): Promise<TokenEstimate>
}

/**
 * Abstract token estimator resolver service. One resolver owns the
 * `tokenEstimator` Cordis service name; provider estimators and the generic
 * fallback register with it.
 */
export abstract class TokenEstimator extends Service {
  /**
   * Estimate input tokens for one assembled request, selecting the provider
   * estimator by `(provider, model)` and falling back to the generic estimator.
   *
   * @param input - provider, model, and the fully assembled request.
   * @returns an estimate result, either available or explicitly unavailable.
   */
  abstract estimateInput(input: {
    provider: string
    model: string
    request: GenerateOptions
  }): Promise<TokenEstimateResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Token estimator capability. Consumers: agent preflight, compaction,
     * resource governor, router feature capture. */
    tokenEstimator: TokenEstimator
  }
}

/** Configurable policy thresholds for context budget evaluation. */
export interface ContextBudgetPolicy {
  /** Safety margin subtracted from the context window. */
  safetyMarginTokens: number
  /** Usage ratio at or above which `warning` status applies. */
  warningRatio: number
  /** Usage ratio at or above which `compact` status applies. */
  compactRatio: number
  /** Usage ratio at or above which `reject` status applies. */
  rejectRatio: number
}

/** Default policy values. These are policy defaults, not estimator semantics. */
export const DEFAULT_CONTEXT_BUDGET_POLICY: ContextBudgetPolicy = {
  safetyMarginTokens: 20_000,
  warningRatio: 0.75,
  compactRatio: 0.85,
  rejectRatio: 0.95,
}

/** Context pressure status derived from the usage ratio. */
export type ContextStatus = 'normal' | 'warning' | 'compact' | 'reject'

/** Context budget evaluation: the result of applying a policy to an estimate. */
export interface ContextUtilization {
  /** Model context window capacity in tokens (from the model registry). */
  contextWindowTokens: number
  /** Estimated input tokens from the estimator. */
  estimatedInputTokens: number
  /** Reserved output tokens from the request's `maxTokens`. */
  reservedOutputTokens: number
  /** Safety margin from the budget policy. */
  safetyMarginTokens: number
  /** `estimatedInput + reservedOutput + safetyMargin`. */
  estimatedTotalTokens: number
  /** `contextWindow - estimatedTotal`. */
  remainingTokens: number
  /** `estimatedTotal / contextWindow`, clamped to [0, 1]. */
  usageRatio: number
  /** Status derived from the usage ratio and policy thresholds. */
  status: ContextStatus
}

/**
 * Evaluate context budget from an estimate, model capacity, and policy.
 *
 * Computes `usageRatio = (estimatedInput + reservedOutput + safetyMargin) / contextWindow`,
 * then derives `status` from the policy thresholds. The estimator itself is
 * free of policy; this function applies it.
 *
 * @param estimate - the preflight input estimate.
 * @param contextWindowTokens - model context window from the registry.
 * @param reservedOutputTokens - requested max output tokens (0 if unspecified).
 * @param policy - budget policy thresholds.
 * @returns a `ContextUtilization` with status and remaining tokens.
 */
export function evaluateContextBudget(
  estimate: TokenEstimate,
  contextWindowTokens: number,
  reservedOutputTokens: number,
  policy: ContextBudgetPolicy,
): ContextUtilization {
  const estimatedTotalTokens = estimate.tokens + reservedOutputTokens + policy.safetyMarginTokens
  const usageRatio = contextWindowTokens > 0
    ? Math.min(1, estimatedTotalTokens / contextWindowTokens)
    : 1
  const remainingTokens = Math.max(0, contextWindowTokens - estimatedTotalTokens)
  let status: ContextStatus
  if (usageRatio >= policy.rejectRatio) status = 'reject'
  else if (usageRatio >= policy.compactRatio) status = 'compact'
  else if (usageRatio >= policy.warningRatio) status = 'warning'
  else status = 'normal'
  return {
    contextWindowTokens,
    estimatedInputTokens: estimate.tokens,
    reservedOutputTokens,
    safetyMarginTokens: policy.safetyMarginTokens,
    estimatedTotalTokens,
    remainingTokens,
    usageRatio,
    status,
  }
}
