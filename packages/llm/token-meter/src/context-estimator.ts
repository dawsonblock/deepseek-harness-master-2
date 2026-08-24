/**
 * Token estimator resolver and generic fallback.
 *
 * Re-exports from `./token-estimator-resolver.ts`. The contract types live in
 * `dsh-llm`; this module provides the resolver implementation.
 *
 * @module @deepseek-ai/dsh-token-meter/context-estimator
 */

export {
  GENERIC_ESTIMATOR_IDENTITY,
  GenericTokenEstimator,
  TokenEstimatorResolver,
  registerTokenEstimatorResolver,
} from './token-estimator-resolver.ts'

export type {
  TokenEstimator,
  TokenEstimate,
  TokenEstimateResult,
  EstimatorIdentity,
  EstimatePrecision,
  ProviderTokenEstimator,
  TokenizerBackend,
} from '@deepseek-ai/dsh-llm'
