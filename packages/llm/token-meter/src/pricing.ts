/**
 * Versioned model pricing and cost calculation.
 *
 * Pricing is separate from token usage: immutable `TokenUsage` records remain
 * valid when prices change. Cost is derived from `TokenUsage + ModelPricing`
 * and carries the pricing version that produced it, so historical economics
 * remain reproducible.
 *
 * @module @deepseek-ai/dsh-token-meter/pricing
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { totalPromptTokens } from '@deepseek-ai/dsh-llm'

/** Per-million-token rates for one provider/model under one pricing version. */
export interface ModelPricing {
  /** Provider route key. */
  provider: string
  /** Model id the pricing applies to. */
  model: string
  /** Billing currency. */
  currency: 'USD'
  /** Pricing snapshot identifier for reproducible cost recalculation. */
  version: string
  /** ISO-8601 date when this pricing was observed and pinned in the repository. */
  observedAt: string
  /** ISO-8601 date when the provider says this pricing became effective, when published. */
  effectiveFrom?: string
  /** Per-million-token rates. */
  perMillion: {
    /** Cache-hit input token rate. */
    cacheHitInput: number
    /** Cache-miss input token rate. */
    cacheMissInput: number
    /** Output token rate. */
    output: number
  }
}

/** Derived cost from one `TokenUsage` record under one `ModelPricing` version. */
export interface CalculatedModelCost {
  /** Cost amount in the pricing's currency. */
  amount: number
  /** Currency matching {@link ModelPricing.currency}. */
  currency: 'USD'
  /** Pricing snapshot identifier that produced this cost. */
  pricingVersion: string
  /** Per-component cost breakdown for billing debuggability. */
  components: {
    /** Cost from cache-hit input tokens. */
    cacheHitInput: number
    /** Cost from cache-miss input tokens. */
    cacheMissInput: number
    /** Cost from output tokens. */
    output: number
  }
  /** Whether the calculation is exact or a conservative estimate. */
  confidence: 'exact' | 'conservative-estimate'
}

/**
 * DeepSeek V4 USD pricing observed and pinned on 2026-08-23. DeepSeek explicitly
 * warns that prices can change and does not publish an official effective-from
 * date; `observedAt` records when this snapshot was taken, and `effectiveFrom`
 * is absent because the provider has not published one.
 */
export const DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23: readonly ModelPricing[] = Object.freeze([
  {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    currency: 'USD',
    version: 'deepseek-v4-usd-observed-2026-08-23',
    observedAt: '2026-08-23',
    perMillion: {
      cacheHitInput: 0.0028,
      cacheMissInput: 0.14,
      output: 0.28,
    },
  },
  {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    currency: 'USD',
    version: 'deepseek-v4-usd-observed-2026-08-23',
    observedAt: '2026-08-23',
    perMillion: {
      cacheHitInput: 0.003625,
      cacheMissInput: 0.435,
      output: 0.87,
    },
  },
])

/** Default pricing registry: DeepSeek V4 Flash and Pro under the 2026-08-23 observation snapshot. */
export const DEFAULT_PRICING_REGISTRY: readonly ModelPricing[] = DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23

/**
 * Look up pricing for one provider/model. Returns the first matching entry;
 * callers needing versioned lookups should filter the registry themselves.
 * @param registry - pricing entries to search.
 * @param provider - provider route key.
 * @param model - model id.
 * @returns the matching `ModelPricing`, or `undefined` when no entry exists.
 */
export function lookupPricing(
  registry: readonly ModelPricing[],
  provider: string,
  model: string,
): ModelPricing | undefined {
  return registry.find(entry => entry.provider === provider && entry.model === model)
}

/**
 * Calculate cost from one `TokenUsage` record under one `ModelPricing` version.
 *
 * Uses the disjoint convention: `cacheReadTokens` is cache-hit input,
 * `cacheMissTokens ?? inputTokens` is cache-miss input, and `outputTokens` is
 * output. Does NOT charge from `totalTokens` (cache-hit and cache-miss have
 * different prices). Does NOT add `reasoningTokens` separately (DeepSeek bills
 * reasoning as part of completion usage).
 *
 * When cache fields are absent (legacy/unclassified usage), all known input is
 * treated as cache-miss for cost estimation, and `confidence` is set to
 * `'conservative-estimate'`. When cache hit/miss are present and `source` is
 * `'provider'`, `confidence` is `'exact'`.
 * @param usage - the token usage record to price.
 * @param pricing - the pricing version to apply.
 * @returns the derived cost with per-component breakdown and confidence label.
 */
export function calculateCost(usage: TokenUsage, pricing: ModelPricing): CalculatedModelCost {
  const cacheHit = usage.cacheReadTokens ?? 0
  const cacheMiss = usage.cacheMissTokens ?? usage.inputTokens
  const output = usage.outputTokens
  const { cacheHitInput: hitRate, cacheMissInput: missRate, output: outRate } = pricing.perMillion
  const cacheHitCost = (cacheHit / 1_000_000) * hitRate
  const cacheMissCost = (cacheMiss / 1_000_000) * missRate
  const outputCost = (output / 1_000_000) * outRate
  const hasCacheDecomposition = usage.cacheReadTokens !== undefined || usage.cacheMissTokens !== undefined
  const confidence: CalculatedModelCost['confidence'] = hasCacheDecomposition && usage.source === 'provider'
    ? 'exact'
    : 'conservative-estimate'
  return {
    amount: cacheHitCost + cacheMissCost + outputCost,
    currency: pricing.currency,
    pricingVersion: pricing.version,
    components: {
      cacheHitInput: cacheHitCost,
      cacheMissInput: cacheMissCost,
      output: outputCost,
    },
    confidence,
  }
}

// Re-export for consumers that import from the pricing module.
export { totalPromptTokens }
