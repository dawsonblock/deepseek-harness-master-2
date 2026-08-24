import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  deriveRoutingOutcomes,
  deriveRoutingOutcomesWithFeatures,
  deriveTaskEconomics,
  deriveWorkloadFeatures,
} from '../src/routing-outcome.ts'
import { DEFAULT_PRICING_REGISTRY } from '../src/pricing.ts'

function routingDecisionEvent(
  seq: number,
  turn: number,
  step: number,
  routingDecisionId: string,
  selected: { provider: string; model: string },
  authority = 'router',
): SessionEvent {
  return {
    type: 'model/routing-decision',
    seq,
    time: 0,
    data: {
      turn,
      step,
      routingDecisionId,
      proposed: selected,
      selected,
      authority,
      reason: 'scoring',
      threshold: 5,
      policyVersion: 1,
    },
  } as SessionEvent
}

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

function toolCallEvent(seq: number, turn: number, step: number, callId: string): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 0,
    data: { turn, step, callId, name: 'bash', arguments: '{}' },
  } as SessionEvent
}

function toolResultEvent(
  seq: number,
  turn: number,
  step: number,
  callId: string,
  isError = false,
): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    data: {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError }],
        role: 'user',
        id: 'm1',
      },
    },
  } as SessionEvent
}

function verificationEvent(seq: number, passed: boolean, checks: Array<{ passed: boolean }>): SessionEvent {
  return {
    type: 'goal/verification',
    seq,
    time: 0,
    data: {
      kind: 'goal/verification',
      version: 2,
      goal: { id: 'g1', revision: 1 },
      passed,
      verifiedAt: 0,
      basisSeq: 0,
      registryFingerprint: 'fp',
      checks,
    },
    ignorable: true,
  } as SessionEvent
}

function outcomeReceiptEvent(
  seq: number,
  verdict: 'pass' | 'pass-with-warnings',
  criteria: Array<{ state: string }>,
): SessionEvent {
  return {
    type: 'goal/outcome-receipt',
    seq,
    time: 0,
    data: {
      receiptVersion: 1,
      goalId: 'g1',
      goalRevision: 1,
      contractHash: 'ch',
      verifierPolicyHash: 'vph',
      verifiedAt: 0,
      criteria,
      artifacts: [],
      unresolvedWarnings: [],
      overallVerdict: verdict,
      receiptHash: 'rh-001',
    },
    ignorable: true,
  } as SessionEvent
}

function turnEndEvent(seq: number, turn: number, reason: string): SessionEvent {
  return {
    type: 'turn/end',
    seq,
    time: 0,
    data: { turn, reason: { kind: reason } },
  } as SessionEvent
}

describe('deriveRoutingOutcomes', () => {
  it('joins routing decision to model/usage and produces cost', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 800, cacheMissTokens: 1000, source: 0 },
        'R1',
      ),
      toolCallEvent(2, 1, 1, 'c1'),
      toolResultEvent(3, 1, 1, 'c1'),
      verificationEvent(4, true, [{ passed: true }]),
      turnEndEvent(5, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes).toHaveLength(1)
    const o = outcomes[0]!
    expect(o.routingDecisionId).toBe('R1')
    expect(o.route.model).toBe('deepseek-v4-flash')
    expect(o.route.authority).toBe('router')
    expect(o.accounting.attempts).toBe(1)
    expect(o.accounting.inputTokens).toBe(1000)
    expect(o.accounting.cacheHitTokens).toBe(800)
    expect(o.accounting.cacheMissTokens).toBe(1000)
    expect(o.accounting.outputTokens).toBe(500)
    expect(o.accounting.costUsd).toBeGreaterThan(0)
    expect(o.accounting.pricingVersion).toBe('deepseek-v4-usd-observed-2026-08-23')
    expect(o.executionQuality.toolCalls).toBe(1)
    expect(o.executionQuality.toolFailures).toBe(0)
    expect(o.outcome.status).toBe('verified-pass')
  })

  it('counts retries as multiple attempts under one routing decision', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 100, source: 0 }, 'R1',
      ),
      usageEvent(2, 1, 1, 2, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1500, outputTokens: 200, source: 0 }, 'R1',
      ),
      verificationEvent(3, true, [{ passed: true }]),
      turnEndEvent(4, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.accounting.attempts).toBe(2)
    expect(outcomes[0]!.accounting.inputTokens).toBe(2500)
    expect(outcomes[0]!.accounting.outputTokens).toBe(300)
  })

  it('classifies verified-fail when verification fails', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, source: 0 }, 'R1',
      ),
      verificationEvent(2, false, [{ passed: false }]),
      turnEndEvent(3, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes[0]!.outcome.status).toBe('verified-fail')
    expect(outcomes[0]!.outcome.criteriaPassed).toBe(0)
    expect(outcomes[0]!.outcome.criteriaTotal).toBe(1)
  })

  it('classifies unverified when turn ends without verification', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, source: 0 }, 'R1',
      ),
      turnEndEvent(2, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes[0]!.outcome.status).toBe('unverified')
  })

  it('counts tool failures from tool/result isError', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, source: 0 }, 'R1',
      ),
      toolCallEvent(2, 1, 1, 'c1'),
      toolCallEvent(3, 1, 1, 'c2'),
      toolResultEvent(4, 1, 1, 'c1', false),
      toolResultEvent(5, 1, 1, 'c2', true),
      verificationEvent(6, true, [{ passed: true }]),
      turnEndEvent(7, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes[0]!.executionQuality.toolCalls).toBe(2)
    expect(outcomes[0]!.executionQuality.toolFailures).toBe(1)
  })

  it('detects inferred repair relationship between routing decisions in the same turn', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 100, source: 0 }, 'R1',
      ),
      verificationEvent(2, false, [{ passed: false }]),
      routingDecisionEvent(3, 1, 2, 'R2', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      usageEvent(4, 1, 2, 1, 'deepseek-official', 'deepseek-v4-pro',
        { inputTokens: 2000, outputTokens: 500, source: 0 }, 'R2',
      ),
      verificationEvent(5, true, [{ passed: true }]),
      turnEndEvent(6, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]!.routingDecisionId).toBe('R1')
    expect(outcomes[0]!.outcome.status).toBe('verified-fail')
    expect(outcomes[0]!.repairAttribution).toEqual({ kind: 'none' })
    expect(outcomes[1]!.routingDecisionId).toBe('R2')
    expect(outcomes[1]!.repairAttribution).toEqual({ kind: 'inferred', routingDecisionId: 'R1' })
    expect(outcomes[1]!.outcome.status).toBe('verified-pass')
  })

  it('prefers explicit repairOf metadata over inference', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 100, source: 0 }, 'R1',
      ),
      verificationEvent(2, false, [{ passed: false }]),
      {
        ...routingDecisionEvent(3, 1, 2, 'R2', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
        data: {
          turn: 1, step: 2, routingDecisionId: 'R2',
          proposed: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
          selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
          authority: 'router', reason: 'scoring', threshold: 5, policyVersion: 1,
          repairOf: 'R1',
        },
      } as SessionEvent,
      usageEvent(4, 1, 2, 1, 'deepseek-official', 'deepseek-v4-pro',
        { inputTokens: 2000, outputTokens: 500, source: 0 }, 'R2',
      ),
      verificationEvent(5, true, [{ passed: true }]),
      turnEndEvent(6, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes[1]!.repairAttribution).toEqual({ kind: 'explicit', routingDecisionId: 'R1' })
  })

  it('reports none when no failed verification occurs between decisions', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 100, source: 0 }, 'R1',
      ),
      verificationEvent(2, true, [{ passed: true }]),
      routingDecisionEvent(3, 1, 2, 'R2', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      usageEvent(4, 1, 2, 1, 'deepseek-official', 'deepseek-v4-pro',
        { inputTokens: 2000, outputTokens: 500, source: 0 }, 'R2',
      ),
      verificationEvent(5, true, [{ passed: true }]),
      turnEndEvent(6, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes[1]!.repairAttribution).toEqual({ kind: 'none' })
  })

  it('reports none when a user/task boundary intervenes between decisions', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 100, source: 0 }, 'R1',
      ),
      verificationEvent(2, false, [{ passed: false }]),
      turnEndEvent(3, 1, 'completed'),
      { type: 'turn/start', seq: 4, time: 0, data: { turn: 2 } } as SessionEvent,
      routingDecisionEvent(5, 2, 1, 'R2', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      usageEvent(6, 2, 1, 1, 'deepseek-official', 'deepseek-v4-pro',
        { inputTokens: 2000, outputTokens: 500, source: 0 }, 'R2',
      ),
      verificationEvent(7, true, [{ passed: true }]),
      turnEndEvent(8, 2, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes[1]!.repairAttribution).toEqual({ kind: 'none' })
  })

  it('joins outcome-receipt and carries receiptId', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-pro',
        { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 1500, cacheMissTokens: 2000, source: 0 }, 'R1',
      ),
      outcomeReceiptEvent(2, 'pass', [{ state: 'pass' }, { state: 'pass' }]),
      verificationEvent(3, true, [{ passed: true }, { passed: true }]),
      turnEndEvent(4, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes[0]!.outcome.status).toBe('verified-pass')
    expect(outcomes[0]!.outcome.receiptId).toBe('rh-001')
    expect(outcomes[0]!.outcome.criteriaPassed).toBe(2)
    expect(outcomes[0]!.outcome.criteriaTotal).toBe(2)
  })
})

describe('deriveTaskEconomics', () => {
  it('aggregates flash and pro costs across routing decisions', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, source: 0 }, 'R1',
      ),
      verificationEvent(2, false, [{ passed: false }]),
      routingDecisionEvent(3, 1, 2, 'R2', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      usageEvent(4, 1, 2, 1, 'deepseek-official', 'deepseek-v4-pro',
        { inputTokens: 2000, outputTokens: 1000, source: 0 }, 'R2',
      ),
      verificationEvent(5, true, [{ passed: true }]),
      turnEndEvent(6, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    const economics = deriveTaskEconomics(outcomes)
    expect(economics.routingDecisions).toBe(2)
    expect(economics.totalModelCalls).toBe(2)
    expect(economics.flashCostUsd).toBeGreaterThan(0)
    expect(economics.proCostUsd).toBeGreaterThan(0)
    expect(economics.totalCostUsd).toBeCloseTo(economics.flashCostUsd + economics.proCostUsd, 10)
    expect(economics.finalVerifiedOutcome).toBe(true)
  })

  it('reports finalVerifiedOutcome false when no routing decision passes', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(1, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, source: 0 }, 'R1',
      ),
      verificationEvent(2, false, [{ passed: false }]),
      turnEndEvent(3, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomes(events, 's1', DEFAULT_PRICING_REGISTRY)
    const economics = deriveTaskEconomics(outcomes)
    expect(economics.finalVerifiedOutcome).toBe(false)
    expect(economics.routingDecisions).toBe(1)
  })
})

describe('deriveWorkloadFeatures', () => {
  it('counts tool classes used before the routing decision', () => {
    const events: SessionEvent[] = [
      { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } } as SessionEvent,
      toolResultEvent(1, 1, 1, 'c1'),
      { type: 'tool/call', seq: 2, time: 0, data: { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{}' } } as SessionEvent,
      toolResultEvent(3, 1, 1, 'c2'),
      routingDecisionEvent(4, 1, 2, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
    ]
    const features = deriveWorkloadFeatures(events, { cutoffSeq: 4 })
    expect(features.toolClassesUsed).toBe(2)
  })

  it('counts repair iterations from failed verification + goal/edit', () => {
    const events: SessionEvent[] = [
      routingDecisionEvent(0, 1, 1, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      verificationEvent(1, false, [{ passed: false }]),
      {
        type: 'goal/change',
        seq: 2,
        time: 0,
        data: { kind: 'goal/change', version: 1, operation: 'edit', goal: { id: 'g1', revision: 2, objective: 'test', status: 'active', roundsStarted: 1, roundsCompleted: 0 }, roundsStarted: 1, createdAt: 0, updatedAt: 0 },
      } as SessionEvent,
      routingDecisionEvent(3, 1, 2, 'R2', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    ]
    const features = deriveWorkloadFeatures(events, { cutoffSeq: 3 })
    expect(features.repairIteration).toBe(1)
  })

  it('tracks conversation tokens from model/usage', () => {
    const events: SessionEvent[] = [
      usageEvent(0, 1, 1, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, source: 0 }, 'R1',
      ),
      routingDecisionEvent(1, 1, 2, 'R2', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    ]
    const features = deriveWorkloadFeatures(events, { cutoffSeq: 1 })
    expect(features.conversationTokens).toBe(1500)
  })

  it('proves post-decision events do not leak into features (cutoff invariant)', () => {
    const preDecision: SessionEvent[] = [
      { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } } as SessionEvent,
      toolResultEvent(1, 1, 1, 'c1'),
    ]
    const routingDecision = routingDecisionEvent(2, 1, 2, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    // Post-decision events that must not affect features.
    const postDecision: SessionEvent[] = [
      usageEvent(3, 1, 2, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 9999, outputTokens: 9999, totalTokens: 99999, source: 0 }, 'R1',
      ),
      { type: 'tool/call', seq: 4, time: 0, data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{}' } } as SessionEvent,
      verificationEvent(5, false, [{ passed: false }]),
      {
        type: 'goal/change',
        seq: 6,
        time: 0,
        data: { kind: 'goal/change', version: 1, operation: 'edit', goal: { id: 'g1', revision: 2, objective: 'test', status: 'active', roundsStarted: 1, roundsCompleted: 0 }, roundsStarted: 1, createdAt: 0, updatedAt: 0 },
      } as SessionEvent,
    ]
    const withPost = [...preDecision, routingDecision, ...postDecision]
    const withoutPost = [...preDecision, routingDecision]
    const featuresWithPost = deriveWorkloadFeatures(withPost, { cutoffSeq: 2 })
    const featuresWithoutPost = deriveWorkloadFeatures(withoutPost, { cutoffSeq: 2 })
    expect(featuresWithPost).toEqual(featuresWithoutPost)
    expect(featuresWithPost.toolClassesUsed).toBe(1)
    expect(featuresWithPost.conversationTokens).toBe(0)
    expect(featuresWithPost.repairIteration).toBe(0)
  })
})

describe('deriveRoutingOutcomesWithFeatures', () => {
  it('attaches workload features to each routing outcome', () => {
    const events: SessionEvent[] = [
      toolCallEvent(0, 1, 1, 'c1'),
      toolResultEvent(1, 1, 1, 'c1'),
      routingDecisionEvent(2, 1, 2, 'R1', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      usageEvent(3, 1, 2, 1, 'deepseek-official', 'deepseek-v4-flash',
        { inputTokens: 1000, outputTokens: 500, source: 0 }, 'R1',
      ),
      verificationEvent(4, true, [{ passed: true }]),
      turnEndEvent(5, 1, 'completed'),
    ]
    const outcomes = deriveRoutingOutcomesWithFeatures(events, 's1', DEFAULT_PRICING_REGISTRY)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.features).toBeDefined()
    expect(outcomes[0]!.features!.toolClassesUsed).toBe(1)
  })
})
