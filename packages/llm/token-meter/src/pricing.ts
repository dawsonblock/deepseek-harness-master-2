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
  /** ISO-8601 instant when this pricing becomes eligible. */
  effectiveFrom?: string
  /** ISO-8601 instant when this pricing stops being eligible. */
  effectiveUntil?: string
  /** Daily UTC windows in which this entry applies; absent means all day. */
  utcWindows?: readonly { startMinute: number; endMinute: number }[]
  /** Provider billing band represented by this entry. */
  billingBand?: 'flat' | 'peak' | 'off-peak'
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

/** Historical flat DeepSeek V4 prices retained for replay before the time-banded schedule. */
export const DEEPSEEK_V4_FLAT_PRICING_BEFORE_2026_08_16: readonly ModelPricing[] = Object.freeze([
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    currency: 'USD',
    version: 'deepseek-v4-usd-flat-before-2026-08-16',
    observedAt: '2026-08-23',
    effectiveUntil: '2026-08-16T16:00:00Z',
    billingBand: 'flat',
    perMillion: {
      cacheHitInput: 0.0028,
      cacheMissInput: 0.14,
      output: 0.28,
    },
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'USD',
    version: 'deepseek-v4-usd-flat-before-2026-08-16',
    observedAt: '2026-08-23',
    effectiveUntil: '2026-08-16T16:00:00Z',
    billingBand: 'flat',
    perMillion: {
      cacheHitInput: 0.003625,
      cacheMissInput: 0.435,
      output: 0.87,
    },
  },
])

const PEAK_UTC_WINDOWS = Object.freeze([
  { startMinute: 60, endMinute: 240 },
  { startMinute: 360, endMinute: 600 },
])
const OFF_PEAK_UTC_WINDOWS = Object.freeze([
  { startMinute: 0, endMinute: 60 },
  { startMinute: 240, endMinute: 360 },
  { startMinute: 600, endMinute: 1_440 },
])

/** DeepSeek V4 peak/off-peak prices effective at 2026-08-16 16:00 UTC. */
export const DEEPSEEK_V4_PRICING_EFFECTIVE_2026_08_16: readonly ModelPricing[] = Object.freeze([
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    currency: 'USD',
    version: 'deepseek-v4-usd-2026-08-16-peak',
    observedAt: '2026-08-25',
    effectiveFrom: '2026-08-16T16:00:00Z',
    utcWindows: PEAK_UTC_WINDOWS,
    billingBand: 'peak',
    perMillion: { cacheHitInput: 0.014, cacheMissInput: 0.44, output: 1.32 },
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    currency: 'USD',
    version: 'deepseek-v4-usd-2026-08-16-off-peak',
    observedAt: '2026-08-25',
    effectiveFrom: '2026-08-16T16:00:00Z',
    utcWindows: OFF_PEAK_UTC_WINDOWS,
    billingBand: 'off-peak',
    perMillion: { cacheHitInput: 0.007, cacheMissInput: 0.22, output: 0.66 },
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'USD',
    version: 'deepseek-v4-usd-2026-08-16-peak',
    observedAt: '2026-08-25',
    effectiveFrom: '2026-08-16T16:00:00Z',
    utcWindows: PEAK_UTC_WINDOWS,
    billingBand: 'peak',
    perMillion: { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'USD',
    version: 'deepseek-v4-usd-2026-08-16-off-peak',
    observedAt: '2026-08-25',
    effectiveFrom: '2026-08-16T16:00:00Z',
    utcWindows: OFF_PEAK_UTC_WINDOWS,
    billingBand: 'off-peak',
    perMillion: { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 },
  },
])

/** Default pricing registry covering historical flat and current time-banded V4 prices. */
export const DEFAULT_PRICING_REGISTRY: readonly ModelPricing[] = Object.freeze([
  ...DEEPSEEK_V4_FLAT_PRICING_BEFORE_2026_08_16,
  ...DEEPSEEK_V4_PRICING_EFFECTIVE_2026_08_16,
])

/**
 * Look up pricing in a registry containing at most one entry per provider/model.
 * @param registry - static pricing entries to search.
 * @param provider - provider route key.
 * @param model - model id.
 * @returns the matching static entry, or `undefined` when none exists.
 */
export function lookupPricing(
  registry: readonly ModelPricing[],
  provider: string,
  model: string,
): ModelPricing | undefined {
  const matches = registry.filter(entry => entry.provider === provider && entry.model === model)
  if (matches.length > 1) {
    throw new Error(`lookupPricing: ${provider}/${model} has time-dependent entries; use lookupPricingAt`)
  }
  return matches[0]
}

function appliesAt(entry: ModelPricing, at: Date): boolean {
  const instant = at.getTime()
  if (entry.effectiveFrom !== undefined && instant < Date.parse(entry.effectiveFrom)) return false
  if (entry.effectiveUntil !== undefined && instant >= Date.parse(entry.effectiveUntil)) return false
  if (entry.utcWindows === undefined) return true
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes()
  return entry.utcWindows.some(window => minute >= window.startMinute && minute < window.endMinute)
}

/**
 * Resolve historical or time-banded pricing at one billing instant.
 * @param registry - versioned and scheduled pricing entries to search.
 * @param provider - provider route key.
 * @param model - model id.
 * @param at - provider billing instant.
 * @returns the sole applicable entry, or `undefined` when none exists.
 */
export function lookupPricingAt(
  registry: readonly ModelPricing[],
  provider: string,
  model: string,
  at: Date,
): ModelPricing | undefined {
  if (Number.isNaN(at.getTime())) throw new Error('lookupPricingAt: at must be a valid date')
  const matches = registry.filter(entry =>
    entry.provider === provider && entry.model === model && appliesAt(entry, at),
  )
  if (matches.length > 1) {
    throw new Error(`lookupPricingAt: ${provider}/${model} has ${matches.length} applicable entries`)
  }
  return matches[0]
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
