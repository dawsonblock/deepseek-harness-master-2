import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  calculateCost,
  DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23,
  lookupPricing,
  DEFAULT_PRICING_REGISTRY,
} from '../src/pricing.ts'
import type { ModelPricing } from '../src/pricing.ts'

const flashPricing = lookupPricing(DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23, 'deepseek', 'deepseek-v4-flash')!
const proPricing = lookupPricing(DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23, 'deepseek', 'deepseek-v4-pro')!

describe('pricing registry', () => {
  it('contains Flash and Pro under the 2026-08-23 observation snapshot', () => {
    expect(DEEPSEEK_V4_PRICING_OBSERVED_2026_08_23).toHaveLength(2)
    expect(flashPricing).toBeDefined()
    expect(proPricing).toBeDefined()
    expect(flashPricing.version).toBe('deepseek-v4-usd-observed-2026-08-23')
    expect(proPricing.version).toBe('deepseek-v4-usd-observed-2026-08-23')
  })

  it('records observedAt without effectiveFrom (DeepSeek does not publish one)', () => {
    expect(flashPricing.observedAt).toBe('2026-08-23')
    expect(flashPricing.effectiveFrom).toBeUndefined()
    expect(proPricing.observedAt).toBe('2026-08-23')
    expect(proPricing.effectiveFrom).toBeUndefined()
  })

  it('Flash cache-hit rate is cheaper than cache-miss', () => {
    expect(flashPricing.perMillion.cacheHitInput).toBeLessThan(flashPricing.perMillion.cacheMissInput)
  })

  it('Pro is more expensive than Flash across all buckets', () => {
    expect(proPricing.perMillion.cacheHitInput).toBeGreaterThan(flashPricing.perMillion.cacheHitInput)
    expect(proPricing.perMillion.cacheMissInput).toBeGreaterThan(flashPricing.perMillion.cacheMissInput)
    expect(proPricing.perMillion.output).toBeGreaterThan(flashPricing.perMillion.output)
  })

  it('lookupPricing returns undefined for unknown models', () => {
    expect(lookupPricing(DEFAULT_PRICING_REGISTRY, 'deepseek', 'unknown-model')).toBeUndefined()
  })
})

describe('calculateCost: Flash exact pricing', () => {
  it('splits cache hit/miss correctly', () => {
    const usage: TokenUsage = {
      inputTokens: 20_000,
      outputTokens: 10_000,
      cacheReadTokens: 100_000,
      cacheMissTokens: 20_000,
      source: 'provider',
    }
    const cost = calculateCost(usage, flashPricing)
    expect(cost.confidence).toBe('exact')
    expect(cost.currency).toBe('USD')
    expect(cost.pricingVersion).toBe('deepseek-v4-usd-observed-2026-08-23')
    // 100K/1M * $0.0028 = $0.00028
    expect(cost.components.cacheHitInput).toBeCloseTo(0.00028, 10)
    // 20K/1M * $0.14 = $0.0028
    expect(cost.components.cacheMissInput).toBeCloseTo(0.0028, 10)
    // 10K/1M * $0.28 = $0.0028
    expect(cost.components.output).toBeCloseTo(0.0028, 10)
    expect(cost.amount).toBeCloseTo(0.00588, 10)
  })
})

describe('calculateCost: Pro exact pricing', () => {
  it('splits cache hit/miss correctly', () => {
    const usage: TokenUsage = {
      inputTokens: 20_000,
      outputTokens: 10_000,
      cacheReadTokens: 100_000,
      cacheMissTokens: 20_000,
      source: 'provider',
    }
    const cost = calculateCost(usage, proPricing)
    expect(cost.confidence).toBe('exact')
    // 100K/1M * $0.003625 = $0.0003625
    expect(cost.components.cacheHitInput).toBeCloseTo(0.0003625, 10)
    // 20K/1M * $0.435 = $0.0087
    expect(cost.components.cacheMissInput).toBeCloseTo(0.0087, 10)
    // 10K/1M * $0.87 = $0.0087
    expect(cost.components.output).toBeCloseTo(0.0087, 10)
    expect(cost.amount).toBeCloseTo(0.0177625, 10)
  })
})

describe('calculateCost: reasoning present, no double billing', () => {
  it('does not add reasoning tokens to cost', () => {
    const usage: TokenUsage = {
      inputTokens: 1_000,
      outputTokens: 10_000,
      cacheReadTokens: 5_000,
      cacheMissTokens: 1_000,
      reasoningTokens: 4_000,
      source: 'provider',
    }
    const cost = calculateCost(usage, flashPricing)
    // Output cost should be based on outputTokens (10K), not output + reasoning.
    // 10K/1M * $0.28 = $0.0028
    expect(cost.components.output).toBeCloseTo(0.0028, 10)
    // 5K/1M * $0.0028 = $0.000014, 1K/1M * $0.14 = $0.00014
    expect(cost.amount).toBeCloseTo(0.000014 + 0.00014 + 0.0028, 10)
  })
})

describe('calculateCost: cache fields absent', () => {
  it('treats all input as cache-miss with conservative-estimate confidence', () => {
    const usage: TokenUsage = {
      inputTokens: 100_000,
      outputTokens: 10_000,
    }
    const cost = calculateCost(usage, flashPricing)
    expect(cost.confidence).toBe('conservative-estimate')
    expect(cost.components.cacheHitInput).toBe(0)
    // 100K/1M * $0.14 = $0.014
    expect(cost.components.cacheMissInput).toBeCloseTo(0.014, 10)
    // 10K/1M * $0.28 = $0.0028
    expect(cost.components.output).toBeCloseTo(0.0028, 10)
    expect(cost.amount).toBeCloseTo(0.0168, 10)
  })

  it('legacy usage without source is conservative-estimate even with cache fields', () => {
    const usage: TokenUsage = {
      inputTokens: 20_000,
      outputTokens: 10_000,
      cacheReadTokens: 100_000,
      cacheMissTokens: 20_000,
      // source absent — legacy/unclassified
    }
    const cost = calculateCost(usage, flashPricing)
    expect(cost.confidence).toBe('conservative-estimate')
  })
})

describe('calculateCost: estimated usage', () => {
  it('estimated source is never exact', () => {
    const usage: TokenUsage = {
      inputTokens: 20_000,
      outputTokens: 10_000,
      cacheReadTokens: 100_000,
      cacheMissTokens: 20_000,
      source: 'estimated',
    }
    const cost = calculateCost(usage, flashPricing)
    expect(cost.confidence).toBe('conservative-estimate')
  })
})

describe('calculateCost: pricing version reproducibility', () => {
  it('same usage recomputes under different pricing versions', () => {
    const usage: TokenUsage = {
      inputTokens: 20_000,
      outputTokens: 10_000,
      cacheReadTokens: 100_000,
      cacheMissTokens: 20_000,
      source: 'provider',
    }
    const futurePricing: ModelPricing = {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      currency: 'USD',
      version: 'deepseek-v4-usd-observed-2027-01-01',
      observedAt: '2027-01-01',
      perMillion: {
        cacheHitInput: 0.005,
        cacheMissInput: 0.20,
        output: 0.40,
      },
    }
    const currentCost = calculateCost(usage, flashPricing)
    const futureCost = calculateCost(usage, futurePricing)
    expect(currentCost.pricingVersion).toBe('deepseek-v4-usd-observed-2026-08-23')
    expect(futureCost.pricingVersion).toBe('deepseek-v4-usd-observed-2027-01-01')
    // Same usage, different prices → different cost.
    expect(currentCost.amount).not.toBe(futureCost.amount)
    // Both are exact since usage has cache decomposition and provider source.
    expect(currentCost.confidence).toBe('exact')
    expect(futureCost.confidence).toBe('exact')
  })
})

describe('calculateCost: large values', () => {
  it('handles >1M cumulative token totals without overflow', () => {
    const usage: TokenUsage = {
      inputTokens: 2_000_000,
      outputTokens: 1_500_000,
      cacheReadTokens: 3_000_000,
      cacheMissTokens: 2_000_000,
      source: 'provider',
    }
    const cost = calculateCost(usage, flashPricing)
    expect(cost.amount).toBeGreaterThan(0)
    expect(Number.isFinite(cost.amount)).toBe(true)
  })
})
