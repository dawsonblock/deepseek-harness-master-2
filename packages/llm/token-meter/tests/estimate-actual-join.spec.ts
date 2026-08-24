import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEstimationError, deriveTokenEstimationErrors } from '@deepseek-ai/dsh-token-meter'

/** Build a `model/context-preflight` event with pre-routing or post-routing phase. */
function preflightEvent(
  seq: number,
  turn: number,
  step: number,
  attempt: number,
  phase: 'pre-routing' | 'post-routing',
  estimatedInputTokens: number,
  routingDecisionId?: string,
): SessionEvent {
  return {
    seq,
    type: 'model/context-preflight',
    time: Date.now(),
    data: {
      turn,
      step,
      attempt,
      phase,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      estimatedInputTokens,
      reservedOutputTokens: 4096,
      contextWindowTokens: 1_000_000,
      remainingTokens: 1_000_000 - estimatedInputTokens - 4096,
      usageRatio: (estimatedInputTokens + 4096) / 1_000_000,
      status: 'normal',
      estimatorId: 'deepseek-tokenizer',
      estimatorVersion: '1',
      ...routingDecisionId === undefined ? {} : { routingDecisionId },
    },
  } as unknown as SessionEvent
}

/** Build a `model/usage` event with provider-authoritative prompt tokens. */
function usageEvent(
  seq: number,
  turn: number,
  step: number,
  attempt: number,
  promptTokens: number,
  routingDecisionId?: string,
): SessionEvent {
  return {
    seq,
    type: 'model/usage',
    time: Date.now(),
    data: {
      turn,
      step,
      attempt,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      usage: {
        inputTokens: promptTokens,
        outputTokens: 100,
        totalTokens: promptTokens + 100,
        source: 'provider',
        ...routingDecisionId === undefined ? {} : { routingDecisionId },
      },
      ...routingDecisionId === undefined ? {} : { routingDecisionId },
    },
  } as unknown as SessionEvent
}

/** Join preflight estimates to provider usage by (turn, step, attempt). */
interface JoinedEstimateActual {
  turn: number
  step: number
  attempt: number
  estimatedInputTokens: number
  actualPromptTokens: number
  routingDecisionId?: string
}

function joinEstimateToActual(events: readonly SessionEvent[]): JoinedEstimateActual[] {
  const estimates = new Map<string, SessionEvent>()
  const usages = new Map<string, SessionEvent>()
  for (const event of events) {
    if (event.type !== 'model/context-preflight' && event.type !== 'model/usage') continue
    const data = event.data as { turn: number; step: number; attempt: number; phase?: string }
    const key = `${data.turn}:${data.step}:${data.attempt}`
    if (event.type === 'model/context-preflight' && data.phase === 'post-routing') {
      estimates.set(key, event)
    } else if (event.type === 'model/usage') {
      usages.set(key, event)
    }
  }
  const joined: JoinedEstimateActual[] = []
  for (const [key, estimate] of estimates) {
    const usage = usages.get(key)
    if (usage === undefined) continue
    const e = estimate.data as { turn: number; step: number; attempt: number; estimatedInputTokens: number; routingDecisionId?: string }
    const u = usage.data as { turn: number; step: number; attempt: number; usage: { inputTokens: number }; routingDecisionId?: string }
    joined.push({
      turn: e.turn,
      step: e.step,
      attempt: e.attempt,
      estimatedInputTokens: e.estimatedInputTokens,
      actualPromptTokens: u.usage.inputTokens,
      ...e.routingDecisionId !== undefined ? { routingDecisionId: e.routingDecisionId } : {},
    })
  }
  return joined.sort((a, b) => a.attempt - b.attempt)
}

describe('estimate-to-actual event join (6D)', () => {
  it('joins one estimate to one usage by (turn, step, attempt) and derives error', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 8, 2, 1, 'post-routing', 91_000),
      usageEvent(2, 8, 2, 1, 94_500),
    ]
    const joined = joinEstimateToActual(events)
    expect(joined).toHaveLength(1)
    expect(joined[0]!.estimatedInputTokens).toBe(91_000)
    expect(joined[0]!.actualPromptTokens).toBe(94_500)

    const error = deriveEstimationError(
      { tokens: 91_000, source: 'estimated', estimator: { id: 'deepseek-tokenizer', version: '1' }, precision: 'tokenizer' },
      94_500,
      'deepseek-official',
      'deepseek-v4-flash',
    )
    expect(error.absoluteError).toBe(3_500)
    expect(error.relativeError).toBeCloseTo(3_500 / 94_500, 5)
  })

  it('joins multiple attempts without cross-joining', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 8, 2, 1, 'post-routing', 91_000),
      usageEvent(2, 8, 2, 1, 94_500),
      preflightEvent(3, 8, 2, 2, 'post-routing', 95_000),
      usageEvent(4, 8, 2, 2, 96_000),
    ]
    const joined = joinEstimateToActual(events)
    expect(joined).toHaveLength(2)
    expect(joined[0]!.attempt).toBe(1)
    expect(joined[0]!.estimatedInputTokens).toBe(91_000)
    expect(joined[0]!.actualPromptTokens).toBe(94_500)
    expect(joined[1]!.attempt).toBe(2)
    expect(joined[1]!.estimatedInputTokens).toBe(95_000)
    expect(joined[1]!.actualPromptTokens).toBe(96_000)
  })

  it('preserves routingDecisionId on both events when available', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 5, 1, 1, 'post-routing', 50_000, 'rd-abc'),
      usageEvent(2, 5, 1, 1, 52_000, 'rd-abc'),
    ]
    const joined = joinEstimateToActual(events)
    expect(joined).toHaveLength(1)
    expect(joined[0]!.routingDecisionId).toBe('rd-abc')
  })

  it('does not join pre-routing estimates to usage (only post-routing)', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 3, 1, 1, 'pre-routing', 40_000),
      preflightEvent(2, 3, 1, 1, 'post-routing', 42_000),
      usageEvent(3, 3, 1, 1, 43_000),
    ]
    const joined = joinEstimateToActual(events)
    expect(joined).toHaveLength(1)
    // The post-routing estimate (42_000) joins, not the pre-routing (40_000).
    expect(joined[0]!.estimatedInputTokens).toBe(42_000)
  })

  it('does not cross-join across different turns or steps', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 1, 1, 1, 'post-routing', 10_000),
      usageEvent(2, 2, 1, 1, 11_000),
    ]
    const joined = joinEstimateToActual(events)
    expect(joined).toHaveLength(0)
  })

  it('preserves estimator provenance separately from provider usage', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 1, 1, 1, 'post-routing', 30_000),
      usageEvent(2, 1, 1, 1, 31_500),
    ]
    const joined = joinEstimateToActual(events)
    expect(joined).toHaveLength(1)

    const estimateEvent = events[0]!
    const usageEvent0 = events[1]!
    const estData = estimateEvent.data as { estimatorId: string; estimatorVersion: string }
    const useData = usageEvent0.data as { usage: { source: string } }

    // Estimator provenance is on the preflight event.
    expect(estData.estimatorId).toBe('deepseek-tokenizer')
    expect(estData.estimatorVersion).toBe('1')
    // Provider-authoritative source is on the usage event.
    expect(useData.usage.source).toBe('provider')
  })
})

describe('deriveTokenEstimationErrors projection', () => {
  it('joins post-routing estimates to usage by (turn, step, attempt)', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 1, 1, 1, 'post-routing', 1000),
      usageEvent(2, 1, 1, 1, 1100),
    ]
    const results = deriveTokenEstimationErrors(events as unknown as { type: string; data: Record<string, unknown> }[])
    expect(results).toHaveLength(1)
    expect(results[0]!.kind).toBe('joined')
    if (results[0]!.kind === 'joined') {
      expect(results[0]!.error.estimated).toBe(1000)
      expect(results[0]!.error.actual).toBe(1100)
      expect(results[0]!.error.absoluteError).toBe(100)
      expect(results[0]!.error.underestimated).toBe(true)
      expect(results[0]!.error.turn).toBe(1)
      expect(results[0]!.error.step).toBe(1)
      expect(results[0]!.error.attempt).toBe(1)
    }
  })

  it('detects routing-decision id mismatch and refuses to join', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 1, 1, 1, 'post-routing', 1000, 'rd-A'),
      usageEvent(2, 1, 1, 1, 1100, 'rd-B'),
    ]
    const results = deriveTokenEstimationErrors(events as unknown as { type: string; data: Record<string, unknown> }[])
    expect(results).toHaveLength(1)
    expect(results[0]!.kind).toBe('routing-mismatch')
    if (results[0]!.kind === 'routing-mismatch') {
      expect(results[0]!.estimateRoutingId).toBe('rd-A')
      expect(results[0]!.usageRoutingId).toBe('rd-B')
    }
  })

  it('joins when routing ids match', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 1, 1, 1, 'post-routing', 1000, 'rd-X'),
      usageEvent(2, 1, 1, 1, 1100, 'rd-X'),
    ]
    const results = deriveTokenEstimationErrors(events as unknown as { type: string; data: Record<string, unknown> }[])
    expect(results).toHaveLength(1)
    expect(results[0]!.kind).toBe('joined')
    if (results[0]!.kind === 'joined') {
      expect(results[0]!.error.routingDecisionId).toBe('rd-X')
    }
  })

  it('reports missing-actual when a preflight has no matching usage', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 1, 1, 1, 'post-routing', 1000),
    ]
    const results = deriveTokenEstimationErrors(events as unknown as { type: string; data: Record<string, unknown> }[])
    expect(results).toHaveLength(1)
    expect(results[0]!.kind).toBe('missing-actual')
  })

  it('reports missing-estimate when a usage has no matching preflight', () => {
    const events: SessionEvent[] = [
      usageEvent(1, 1, 1, 1, 1100),
    ]
    const results = deriveTokenEstimationErrors(events as unknown as { type: string; data: Record<string, unknown> }[])
    expect(results).toHaveLength(1)
    expect(results[0]!.kind).toBe('missing-estimate')
  })

  it('preserves retry isolation: different attempts do not cross-join', () => {
    const events: SessionEvent[] = [
      preflightEvent(1, 1, 1, 1, 'post-routing', 1000),
      usageEvent(2, 1, 1, 1, 1100),
      preflightEvent(3, 1, 1, 2, 'post-routing', 1200),
      usageEvent(4, 1, 1, 2, 1300),
    ]
    const results = deriveTokenEstimationErrors(events as unknown as { type: string; data: Record<string, unknown> }[])
    expect(results).toHaveLength(2)
    expect(results.every(r => r.kind === 'joined')).toBe(true)
    if (results[0]!.kind === 'joined' && results[1]!.kind === 'joined') {
      expect(results[0]!.error.attempt).toBe(1)
      expect(results[0]!.error.estimated).toBe(1000)
      expect(results[1]!.error.attempt).toBe(2)
      expect(results[1]!.error.estimated).toBe(1200)
    }
  })
})
