/**
 * Token estimator resolver and generic fallback implementation.
 *
 * The contract (`TokenEstimator`, `TokenEstimate`, `ProviderTokenEstimator`)
 * lives in `dsh-llm`. This module provides the resolver that owns the
 * `tokenEstimator` Cordis service name, plus the generic character-density
 * fallback estimator. Provider-specific estimators register with the resolver
 * rather than competing for the service name.
 *
 * @module @deepseek-ai/dsh-token-meter/context-estimator
 */

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  TokenEstimator as TokenEstimatorContract,
  type TokenEstimate,
  type TokenEstimateResult,
  type EstimatorIdentity,
  type EstimatePrecision,
  type ProviderTokenEstimator,
} from '@deepseek-ai/dsh-llm'
import { estimateRequestInput } from './context-estimate.ts'

/** Generic fallback estimator identity. */
export const GENERIC_ESTIMATOR_IDENTITY: EstimatorIdentity = {
  id: 'character-heuristic',
  version: '1',
}

/**
 * Generic fallback estimator using a character-density heuristic.
 *
 * Uses approximately 0.3 tokens per character for English text (DeepSeek's
 * approximate ratio), with structural overhead for JSON framing. This is
 * intentionally conservative; actual counts depend on tokenization.
 */
export class GenericTokenEstimator implements ProviderTokenEstimator {
  readonly provider = '*'
  readonly identity = GENERIC_ESTIMATOR_IDENTITY
  readonly precision: EstimatePrecision = 'heuristic'

  supports(_model: string): boolean {
    return true
  }

  estimateInput(request: GenerateOptions): Promise<TokenEstimate> {
    return Promise.resolve(estimateRequestInput(request, {
      estimator: this.identity,
      precision: this.precision,
    }))
  }
}

/**
 * Resolver that owns the `tokenEstimator` Cordis service name. Provider
 * estimators register by `(provider, model)`; the generic fallback covers
 * any request without a matching provider estimator.
 */
export class TokenEstimatorResolver extends TokenEstimatorContract {
  private readonly providers: ProviderTokenEstimator[] = []
  private readonly generic: GenericTokenEstimator

  constructor(ctx: Context) {
    super(ctx, 'tokenEstimator')
    this.generic = new GenericTokenEstimator()
  }

  /** Register a provider-specific estimator. The estimator must declare its
   * provider route and `supports` predicate. */
  registerProvider(estimator: ProviderTokenEstimator): () => void {
    this.providers.push(estimator)
    return () => {
      const index = this.providers.indexOf(estimator)
      if (index !== -1) this.providers.splice(index, 1)
    }
  }

  async estimateInput(input: {
    provider: string
    model: string
    request: GenerateOptions
  }): Promise<TokenEstimateResult> {
    const providerEstimator = this.providers.find(
      candidate =>
        candidate.provider === input.provider && candidate.supports(input.model),
    )
    if (providerEstimator !== undefined) {
      try {
        const estimate = await providerEstimator.estimateInput(input.request)
        return { available: true, estimate }
      } catch {
        // fall through to generic
      }
    }
    try {
      const estimate = await this.generic.estimateInput(input.request)
      return { available: true, estimate }
    } catch {
      return { available: false, reason: 'fallback-estimator-failed' }
    }
  }
}

/**
 * Register the token estimator resolver on the Context. This owns the
 * `tokenEstimator` service name; provider estimators register with the
 * returned resolver instance.
 *
 * @param ctx - the Cordis Context to register on.
 * @returns the registered `TokenEstimatorResolver` instance.
 */
export function registerTokenEstimatorResolver(ctx: Context): TokenEstimatorResolver {
  return new TokenEstimatorResolver(ctx)
}

// Re-export the contract types for backward compatibility with existing
// consumers that imported them from token-meter.
export type {
  TokenEstimator,
  TokenEstimate,
  TokenEstimateResult,
  EstimatorIdentity,
  EstimatePrecision,
  ProviderTokenEstimator,
  TokenizerBackend,
} from '@deepseek-ai/dsh-llm'
