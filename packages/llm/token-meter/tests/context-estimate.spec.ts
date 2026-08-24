import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_BUDGET_POLICY,
  aggregateEstimatorQuality,
  deriveContextWorkloadFeatures,
  deriveEstimationError,
  estimateRequestInput,
  evaluateContextBudget,
} from '../src/context-estimate.ts'
import {
  GENERIC_ESTIMATOR_IDENTITY,
} from '../src/context-estimator.ts'
import type { TokenEstimate } from '../src/context-estimate.ts'

const ESTIMATOR = GENERIC_ESTIMATOR_IDENTITY
const PRECISION = 'heuristic' as const

function textMessage(text: string, role: 'user' | 'assistant' = 'user'): Message {
  return { role, content: [{ type: 'text', text }] } as Message
}

function request(opts: Partial<GenerateOptions> & { messages?: Message[] } = {}): GenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: opts.messages ?? [textMessage('Hello')],
    ...opts,
  } as GenerateOptions
}

function estimate(req: GenerateOptions): TokenEstimate {
  return estimateRequestInput(req, { estimator: ESTIMATOR, precision: PRECISION })
}

describe('estimateRequestInput', () => {
  it('produces a positive estimate with source=estimated', () => {
    const est = estimate(request({ messages: [textMessage('Hello world')] }))
    expect(est.tokens).toBeGreaterThan(0)
    expect(est.source).toBe('estimated')
    expect(est.estimator.id).toBe('character-heuristic')
    expect(est.precision).toBe('heuristic')
  })

  it('is deterministic: same request produces identical estimate', () => {
    const req = request({ messages: [textMessage('The quick brown fox jumps over the lazy dog')] })
    const a = estimate(req)
    const b = estimate(req)
    expect(a).toEqual(b)
  })

  it('content growth: larger text produces larger estimate', () => {
    const small = estimate(request({ messages: [textMessage('Hi')] }))
    const large = estimate(request({ messages: [textMessage('A'.repeat(10000))] }))
    expect(large.tokens).toBeGreaterThan(small.tokens)
  })

  it('tool schemas increase the estimate', () => {
    const withoutTools = estimate(request())
    const withTools = estimate(request({
      tools: [{
        name: 'read',
        description: 'Read a file from the filesystem',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'The absolute path to the file' },
            offset: { type: 'number', description: 'Line offset to start reading from' },
            limit: { type: 'number', description: 'Maximum number of lines to read' },
          },
          required: ['file_path'],
        },
      }],
    }))
    expect(withTools.tokens).toBeGreaterThan(withoutTools.tokens)
  })

  it('large system prompt increases the estimate', () => {
    const withoutSystem = estimate(request())
    const withSystem = estimate(request({ system: 'You are a helpful assistant. '.repeat(100) }))
    expect(withSystem.tokens).toBeGreaterThan(withoutSystem.tokens)
  })

  it('conversation history increases the estimate', () => {
    const oneMessage = estimate(request({ messages: [textMessage('Hello')] }))
    const manyMessages = estimate(request({
      messages: [
        textMessage('Hello'),
        textMessage('Hi there, how are you?', 'assistant'),
        textMessage('I am doing well. Can you help me with a task?'),
        textMessage('Of course! What do you need?', 'assistant'),
        textMessage('I need to write a function that sorts an array.'),
      ],
    }))
    expect(manyMessages.tokens).toBeGreaterThan(oneMessage.tokens)
  })
})

describe('evaluateContextBudget', () => {
  const WINDOW = 1_000_000

  it('output reservation: higher maxOutput reduces remaining tokens', () => {
    const est = estimate(request())
    const lowOutput = evaluateContextBudget(est, WINDOW, 10_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    const highOutput = evaluateContextBudget(est, WINDOW, 100_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    expect(highOutput.remainingTokens).toBeLessThan(lowOutput.remainingTokens)
    expect(highOutput.reservedOutputTokens).toBe(100_000)
    expect(lowOutput.reservedOutputTokens).toBe(10_000)
  })

  it('status is normal when usage ratio is below warning threshold', () => {
    const est = estimate(request())
    const util = evaluateContextBudget(est, WINDOW, 64_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    expect(util.status).toBe('normal')
    expect(util.usageRatio).toBeLessThan(DEFAULT_CONTEXT_BUDGET_POLICY.warningRatio)
  })

  it('status is warning at the warning boundary', () => {
    // Construct an estimate that hits exactly the warning ratio.
    const warningTokens = Math.floor(WINDOW * DEFAULT_CONTEXT_BUDGET_POLICY.warningRatio)
    const est: TokenEstimate = {
      tokens: warningTokens - 20_000 - 64_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    const util = evaluateContextBudget(est, WINDOW, 64_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    expect(util.status).toBe('warning')
  })

  it('status is compact at the compact boundary', () => {
    const compactTokens = Math.floor(WINDOW * DEFAULT_CONTEXT_BUDGET_POLICY.compactRatio)
    const est: TokenEstimate = {
      tokens: compactTokens - 20_000 - 64_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    const util = evaluateContextBudget(est, WINDOW, 64_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    expect(util.status).toBe('compact')
  })

  it('status is reject at the reject boundary', () => {
    const rejectTokens = Math.floor(WINDOW * DEFAULT_CONTEXT_BUDGET_POLICY.rejectRatio)
    const est: TokenEstimate = {
      tokens: rejectTokens - 20_000 - 64_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    const util = evaluateContextBudget(est, WINDOW, 64_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    expect(util.status).toBe('reject')
  })

  it('monotonicity: larger estimated request never produces lower pressure state', () => {
    const small: TokenEstimate = {
      tokens: 100_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    const large: TokenEstimate = {
      tokens: 800_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    const smallUtil = evaluateContextBudget(small, WINDOW, 64_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    const largeUtil = evaluateContextBudget(large, WINDOW, 64_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    const pressureRank = { normal: 0, warning: 1, compact: 2, reject: 3 }
    expect(pressureRank[largeUtil.status]).toBeGreaterThanOrEqual(pressureRank[smallUtil.status])
    expect(largeUtil.usageRatio).toBeGreaterThanOrEqual(smallUtil.usageRatio)
  })
})

describe('deriveEstimationError', () => {
  it('computes absolute and relative error from estimate vs actual', () => {
    const est: TokenEstimate = {
      tokens: 10_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    const error = deriveEstimationError(est, 10_500, 'deepseek-official', 'deepseek-v4-flash')
    expect(error.estimated).toBe(10_000)
    expect(error.actual).toBe(10_500)
    expect(error.absoluteError).toBe(500)
    expect(error.relativeError).toBeCloseTo(500 / 10_500, 6)
    expect(error.estimatorId).toBe('character-heuristic')
    expect(error.provider).toBe('deepseek-official')
    expect(error.model).toBe('deepseek-v4-flash')
  })

  it('does not mutate the original estimate', () => {
    const est: TokenEstimate = {
      tokens: 10_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    deriveEstimationError(est, 10_500, 'deepseek-official', 'deepseek-v4-flash')
    expect(est.tokens).toBe(10_000)
    expect(est.source).toBe('estimated')
  })
})

describe('aggregateEstimatorQuality', () => {
  it('aggregates count, percentiles, and under/overestimate rates', () => {
    const errors = [
      deriveEstimationError(
        { tokens: 100, source: 'estimated', estimator: ESTIMATOR, precision: PRECISION },
        110, 'p', 'm',
      ),
      deriveEstimationError(
        { tokens: 200, source: 'estimated', estimator: ESTIMATOR, precision: PRECISION },
        190, 'p', 'm',
      ),
      deriveEstimationError(
        { tokens: 150, source: 'estimated', estimator: ESTIMATOR, precision: PRECISION },
        150, 'p', 'm',
      ),
    ]
    const quality = aggregateEstimatorQuality(errors)
    expect(quality.count).toBe(3)
    expect(quality.meanAbsoluteError).toBeCloseTo((10 + 10 + 0) / 3, 6)
    expect(quality.underestimateRate).toBeCloseTo(1 / 3, 6)
    expect(quality.overestimateRate).toBeCloseTo(1 / 3, 6)
    expect(quality.p99RelativeError).toBeGreaterThan(0)
  })

  it('returns zeroed quality for empty input', () => {
    const quality = aggregateEstimatorQuality([])
    expect(quality.count).toBe(0)
    expect(quality.meanAbsoluteError).toBe(0)
  })
})

describe('deriveContextWorkloadFeatures', () => {
  it('produces pre-decision context features from utilization', () => {
    const est: TokenEstimate = {
      tokens: 720_000,
      source: 'estimated',
      estimator: ESTIMATOR,
      precision: PRECISION,
    }
    const util = evaluateContextBudget(est, 1_000_000, 64_000, DEFAULT_CONTEXT_BUDGET_POLICY)
    const features = deriveContextWorkloadFeatures(util, est)
    expect(features.estimatedInputTokens).toBe(720_000)
    expect(features.contextWindowTokens).toBe(1_000_000)
    expect(features.requestedOutputTokens).toBe(64_000)
    expect(features.remainingContextTokens).toBe(util.remainingTokens)
    expect(features.contextUsageRatio).toBe(util.usageRatio)
    expect(features.estimatorId).toBe('character-heuristic')
    expect(features.estimatorVersion).toBe('1')
  })
})

describe('GenericTokenEstimator identity and precision', () => {
  it('exposes the character-heuristic identity and heuristic precision', () => {
    expect(GENERIC_ESTIMATOR_IDENTITY.id).toBe('character-heuristic')
    expect(GENERIC_ESTIMATOR_IDENTITY.version).toBe('1')
  })

  it('estimateRequestInput (the estimator pure face) produces a heuristic estimate', () => {
    const est = estimateRequestInput(request({ messages: [textMessage('Hello world')] }), {
      estimator: GENERIC_ESTIMATOR_IDENTITY,
      precision: 'heuristic',
    })
    expect(est.tokens).toBeGreaterThan(0)
    expect(est.source).toBe('estimated')
    expect(est.estimator.id).toBe('character-heuristic')
    expect(est.precision).toBe('heuristic')
  })

  it('estimator failure: fallback does not throw on valid input', () => {
    const est = estimateRequestInput(request(), {
      estimator: GENERIC_ESTIMATOR_IDENTITY,
      precision: 'heuristic',
    })
    expect(est.tokens).toBeGreaterThan(0)
  })
})

describe('provider accounting separation', () => {
  it('estimator result must never carry source=provider', () => {
    const est = estimate(request())
    expect(est.source).not.toBe('provider')
    expect(est.source).toBe('estimated')
  })
})
