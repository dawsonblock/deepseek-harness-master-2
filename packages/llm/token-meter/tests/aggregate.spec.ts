import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  extractUsageRecords,
  routingDecisionAccounting,
  usageByModel,
  usageByRoutingDecision,
  usageBySession,
  usageByTurn,
} from '../src/aggregate.ts'
import { DEFAULT_PRICING_REGISTRY } from '../src/pricing.ts'

function usageEvent(
  seq: number,
  turn: number,
  step: number,
  attempt: number,
  provider: string,
  model: string,
  usage: Record<string, number>,
  routingDecisionId?: string,
): SessionEvent {
  return {
    type: 'model/usage',
    seq,
    time: 0,
    data: {
      turn,
      step,
      attempt,
      provider,
      model,
      usage: { inputTokens: 0, outputTokens: 0, ...usage },
      ...routingDecisionId === undefined ? {} : { routingDecisionId },
    },
    ignorable: true,
  } as SessionEvent
}

const events: SessionEvent[] = [
  // Turn 1, step 1, attempt 1: Flash, retry
  usageEvent(1, 1, 1, 1, 'deepseek', 'deepseek-v4-flash',
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 800, cacheMissTokens: 1000, source: 0, reasoningTokens: 200 },
    'R123',
  ),
  // Turn 1, step 1, attempt 2: Pro escalation, success
  usageEvent(2, 1, 1, 2, 'deepseek', 'deepseek-v4-pro',
    { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 1500, cacheMissTokens: 2000, source: 0, reasoningTokens: 400 },
    'R123',
  ),
  // Turn 2, step 1, attempt 1: Flash, success
  usageEvent(3, 2, 1, 1, 'deepseek', 'deepseek-v4-flash',
    { inputTokens: 500, outputTokens: 200, cacheReadTokens: 300, cacheMissTokens: 500, source: 0 },
    'R124',
  ),
  // Turn 3: manual selection, no routing decision
  usageEvent(4, 3, 1, 1, 'deepseek', 'deepseek-v4-flash',
    { inputTokens: 300, outputTokens: 100 },
  ),
]

const records = extractUsageRecords(events, 'test-session')

describe('extractUsageRecords', () => {
  it('extracts all model/usage events', () => {
    expect(records).toHaveLength(4)
    expect(records[0]!.turn).toBe(1)
    expect(records[0]!.attempt).toBe(1)
    expect(records[0]!.model).toBe('deepseek-v4-flash')
    expect(records[0]!.routingDecisionId).toBe('R123')
  })

  it('preserves undefined routingDecisionId for manual selection', () => {
    expect(records[3]!.routingDecisionId).toBeUndefined()
  })

  it('carries sessionId', () => {
    expect(records[0]!.sessionId).toBe('test-session')
  })
})

describe('usageBySession', () => {
  it('sums all records into one totals object', () => {
    const totals = usageBySession(records)
    expect(totals.requests).toBe(4)
    expect(totals.inputTokens).toBe(3800)
    expect(totals.outputTokens).toBe(1800)
    expect(totals.cacheReadTokens).toBe(2600)
    expect(totals.cacheMissTokens).toBe(3500)
    expect(totals.reasoningTokens).toBe(600)
  })

  it('calculates cache hit rate', () => {
    const totals = usageBySession(records)
    // 2600 / (2600 + 3500) = 0.426...
    expect(totals.cacheHitRate).toBeCloseTo(2600 / 6100, 5)
  })

  it('calculates cost with pricing registry', () => {
    const totals = usageBySession(records, DEFAULT_PRICING_REGISTRY)
    expect(totals.costUsd).toBeGreaterThan(0)
    expect(totals.exactCosts + totals.estimatedCosts).toBe(4)
  })
})

describe('usageByTurn', () => {
  it('groups by turn number', () => {
    const byTurn = usageByTurn(records)
    expect(byTurn.size).toBe(3)
    expect(byTurn.get(1)!.requests).toBe(2)
    expect(byTurn.get(2)!.requests).toBe(1)
    expect(byTurn.get(3)!.requests).toBe(1)
  })
})

describe('usageByModel', () => {
  it('groups by provider/model', () => {
    const byModel = usageByModel(records)
    expect(byModel.size).toBe(2)
    expect(byModel.get('deepseek/deepseek-v4-flash')!.requests).toBe(3)
    expect(byModel.get('deepseek/deepseek-v4-pro')!.requests).toBe(1)
  })

  it('separates Flash and Pro token counts', () => {
    const byModel = usageByModel(records)
    const flash = byModel.get('deepseek/deepseek-v4-flash')!
    const pro = byModel.get('deepseek/deepseek-v4-pro')!
    expect(flash.outputTokens).toBe(800)
    expect(pro.outputTokens).toBe(1000)
  })
})

describe('usageByRoutingDecision', () => {
  it('groups by routing decision id, excluding manual selection', () => {
    const byDecision = usageByRoutingDecision(records)
    expect(byDecision.size).toBe(2)
    expect(byDecision.get('R123')!.requests).toBe(2)
    expect(byDecision.get('R124')!.requests).toBe(1)
  })
})

describe('routingDecisionAccounting', () => {
  it('provides model list and attempt count per routing decision', () => {
    const accounting = routingDecisionAccounting(records, DEFAULT_PRICING_REGISTRY)
    const r123 = accounting.get('R123')!
    expect(r123.routingDecisionId).toBe('R123')
    expect(r123.attempts).toBe(2)
    // R123 used both Flash (attempt 1) and Pro (attempt 2).
    expect(r123.models).toContain('deepseek/deepseek-v4-flash')
    expect(r123.models).toContain('deepseek/deepseek-v4-pro')
    expect(r123.models).toHaveLength(2)
    expect(r123.totals.costUsd).toBeGreaterThan(0)
  })

  it('R124 has one model and one attempt', () => {
    const accounting = routingDecisionAccounting(records, DEFAULT_PRICING_REGISTRY)
    const r124 = accounting.get('R124')!
    expect(r124.attempts).toBe(1)
    expect(r124.models).toEqual(['deepseek/deepseek-v4-flash'])
  })

  it('excludes manual selection (no routing decision id)', () => {
    const accounting = routingDecisionAccounting(records)
    expect(accounting.has(undefined as never)).toBe(false)
    expect(accounting.size).toBe(2)
  })
})
