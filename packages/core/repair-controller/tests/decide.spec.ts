/**
 * Deterministic runtime tests for the repair controller's pure decision
 * logic. Eight scenarios cover the full v0.18 verified-escalation policy.
 *
 * @module @deepseek-ai/dsh-repair-controller/tests/decide.spec
 */

import { describe, expect, it } from 'vitest'
import {
  decideRepair,
  computeFailureFingerprint,
  classifyProgress,
  classifyProviderFailure,
  computeFailurePackageId,
  computeProgressMetrics,
} from '../src/decide.ts'
import { DEFAULT_REPAIR_LIMITS } from '../src/types.ts'
import type { RepairAttempt, RepairDecisionInput, FailurePackage, ModelRef } from '../src/types.ts'

const FLASH: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const PRO: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' }

const FAIL_A: FailurePackage = {
  failedCriteria: ['criterion-1'],
  failingTests: ['test-a'],
  typeErrors: [],
  buildErrors: [],
  changedFiles: ['src/index.ts'],
}

const FAIL_B: FailurePackage = {
  failedCriteria: ['criterion-1', 'criterion-2'],
  failingTests: ['test-a', 'test-b'],
  typeErrors: [],
  buildErrors: [],
  changedFiles: ['src/index.ts'],
}

const FP_A = computeFailureFingerprint(FAIL_A)
const FP_B = computeFailureFingerprint(FAIL_B)

function makeAttempt(
  attempt: number,
  model: ModelRef,
  verified: boolean,
  opts: Partial<RepairAttempt> = {},
): RepairAttempt {
  return {
    attempt,
    attemptId: `test#attempt-${attempt}`,
    model,
    verified,
    verificationStatus: verified ? 'verified-pass' : 'verified-fail',
    routingDecisionId: `rd-${attempt}`,
    costUsd: 0.01,
    latencyMs: 1000,
    ...opts,
  }
}

function makeInput(
  attempts: RepairAttempt[],
  latestFailure?: FailurePackage,
  overrides: Partial<RepairDecisionInput> = {},
): RepairDecisionInput {
  return {
    sessionId: 'test-session' as never,
    turn: 1,
    step: 1,
    initialModel: FLASH,
    currentModel: PRO,
    attempts,
    ...latestFailure !== undefined ? { latestFailure } : {},
    budget: { totalCostUsd: attempts.length * 0.01, elapsedMs: attempts.length * 1000, totalOutputTokens: attempts.length * 500 },
    limits: DEFAULT_REPAIR_LIMITS,
    ...overrides,
  }
}

describe('RepairController.decide — v0.18 verified-escalation policy', () => {
  it('Test 1: Flash → pass → complete (1 attempt, no repair events)', () => {
    const attempts = [makeAttempt(1, FLASH, true)]
    const decision = decideRepair(makeInput(attempts))
    expect(decision).toEqual({ action: 'complete' })
  })

  it('Test 2: Flash fail → Flash repair pass → complete (2 attempts)', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, true),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    expect(decision).toEqual({ action: 'complete' })
  })

  it('Test 3: Flash fail → Flash same failure → Pro escalation', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    expect(decision.action).toBe('pro-escalate')
    if (decision.action === 'pro-escalate') {
      expect(decision.reason).toBe('same-failure-no-progress')
    }
  })

  it('Test 4: Flash fail → Flash partial progress → Flash #3 pass → complete (3 Flash, 0 Pro)', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_B, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'partial' }),
      makeAttempt(3, FLASH, true),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    expect(decision).toEqual({ action: 'complete' })
  })

  it('Test 5: Flash ×3 fail → Pro pass → complete (explicit model/escalation)', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(3, PRO, true),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    expect(decision).toEqual({ action: 'complete' })
  })

  it('Test 6: Flash ×3 fail → Pro ×2 fail → hard stop (5 attempts exactly)', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(3, PRO, false, { failureFingerprint: FP_A }),
      makeAttempt(4, PRO, false, { failureFingerprint: FP_A }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    // After 2 Pro failures, pro is exhausted (maxProAttempts=2)
    // Total attempts = 4, but pro is exhausted
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') {
      expect(decision.reason).toBe('pro-exhausted')
    }
  })

  it('Test 7: Flash fail → Flash progress → Flash #3 fail → Pro (flash limit exhausted)', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_B, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'partial' }),
      makeAttempt(3, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    expect(decision.action).toBe('pro-escalate')
    if (decision.action === 'pro-escalate') {
      expect(decision.reason).toBe('same-failure-no-progress')
    }
  })

  it('Test 8: total attempt limit reached → stop', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(3, PRO, false, { failureFingerprint: FP_A }),
      makeAttempt(4, PRO, false, { failureFingerprint: FP_A }),
      makeAttempt(5, PRO, false, { failureFingerprint: FP_A }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') {
      expect(decision.reason).toBe('attempt-limit')
    }
  })
})

describe('RepairController.decide — edge cases', () => {
  it('empty attempts → stop (verification-impossible)', () => {
    const decision = decideRepair(makeInput([]))
    expect(decision).toEqual({ action: 'stop', reason: 'verification-impossible' })
  })

  it('no latest failure on a failed attempt → stop (verification-impossible)', () => {
    const attempts = [makeAttempt(1, FLASH, false, { failureFingerprint: FP_A })]
    const decision = decideRepair(makeInput(attempts))
    expect(decision).toEqual({ action: 'stop', reason: 'verification-impossible' })
  })

  it('Flash fail → Flash regression → Pro escalation', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_B, progress: 'regression' }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_B))
    expect(decision.action).toBe('pro-escalate')
    if (decision.action === 'pro-escalate') {
      expect(decision.reason).toBe('regression-detected')
    }
  })

  it('Pro fail with Pro attempts remaining → Pro repair', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(3, PRO, false, { failureFingerprint: FP_A }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A))
    expect(decision.action).toBe('pro-escalate')
  })
})

describe('classifyProgress', () => {
  it('first failure → none', () => {
    expect(classifyProgress(undefined, FAIL_A)).toBe('none')
  })

  it('same failure → none', () => {
    expect(classifyProgress(FAIL_A, FAIL_A)).toBe('none')
  })

  it('fewer failures → partial', () => {
    expect(classifyProgress(FAIL_B, FAIL_A)).toBe('partial')
  })

  it('more failures → regression', () => {
    expect(classifyProgress(FAIL_A, FAIL_B)).toBe('regression')
  })
})

describe('classifyProviderFailure', () => {
  it('401 → authentication, not retryable', () => {
    const f = classifyProviderFailure('deepseek', { httpStatus: 401, message: 'Authentication Fails' })
    expect(f.kind).toBe('authentication')
    expect(f.retryable).toBe(false)
  })

  it('403 → authorization, not retryable', () => {
    const f = classifyProviderFailure('deepseek', { httpStatus: 403, message: 'Forbidden' })
    expect(f.kind).toBe('authorization')
    expect(f.retryable).toBe(false)
  })

  it('400 → invalid-request, not retryable', () => {
    const f = classifyProviderFailure('deepseek', { httpStatus: 400, message: 'Bad request' })
    expect(f.kind).toBe('invalid-request')
    expect(f.retryable).toBe(false)
  })

  it('402 → billing, not retryable', () => {
    const f = classifyProviderFailure('deepseek', { httpStatus: 402, message: 'Payment required' })
    expect(f.kind).toBe('billing')
    expect(f.retryable).toBe(false)
  })

  it('429 → rate-limit, retryable', () => {
    const f = classifyProviderFailure('deepseek', { httpStatus: 429, message: 'Too many requests' })
    expect(f.kind).toBe('rate-limit')
    expect(f.retryable).toBe(true)
  })

  it('503 → server, retryable', () => {
    const f = classifyProviderFailure('deepseek', { httpStatus: 503, message: 'Service unavailable' })
    expect(f.kind).toBe('server')
    expect(f.retryable).toBe(true)
  })

  it('500 → server, retryable', () => {
    const f = classifyProviderFailure('deepseek', { httpStatus: 500, message: 'Internal server error' })
    expect(f.kind).toBe('server')
    expect(f.retryable).toBe(true)
  })

  it('timeout message → timeout, retryable', () => {
    const f = classifyProviderFailure('deepseek', { message: 'Request timed out after 30000ms' })
    expect(f.kind).toBe('timeout')
    expect(f.retryable).toBe(true)
  })

  it('network message → network, retryable', () => {
    const f = classifyProviderFailure('deepseek', { message: 'fetch failed: ECONNRESET' })
    expect(f.kind).toBe('network')
    expect(f.retryable).toBe(true)
  })

  it('empty response message → empty-response, not retryable', () => {
    const f = classifyProviderFailure('deepseek', { message: 'Provider returned no assistant output' })
    expect(f.kind).toBe('empty-response')
    expect(f.retryable).toBe(false)
  })

  it('preserves model and requestId', () => {
    const f = classifyProviderFailure('deepseek', {
      httpStatus: 401,
      message: 'Auth fails',
      model: 'deepseek-v4-flash',
      requestId: 'req-abc123',
    })
    expect(f.model).toBe('deepseek-v4-flash')
    expect(f.requestId).toBe('req-abc123')
  })
})

describe('budget gates', () => {
  it('cost budget exceeded → stop (cost-limit)', () => {
    const attempts = [makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' })]
    const decision = decideRepair(makeInput(attempts, FAIL_A, {
      limits: { ...DEFAULT_REPAIR_LIMITS, maxTaskCostUsd: 0.005 },
    }))
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') expect(decision.reason).toBe('cost-limit')
  })

  it('time budget exceeded → stop (time-limit)', () => {
    const attempts = [makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' })]
    const decision = decideRepair(makeInput(attempts, FAIL_A, {
      limits: { ...DEFAULT_REPAIR_LIMITS, maxElapsedMs: 500 },
    }))
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') expect(decision.reason).toBe('time-limit')
  })

  it('cost budget not exceeded → continues normally', () => {
    const attempts = [makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' })]
    const decision = decideRepair(makeInput(attempts, FAIL_A, {
      limits: { ...DEFAULT_REPAIR_LIMITS, maxTaskCostUsd: 1.0 },
    }))
    expect(decision.action).toBe('flash-repair')
  })
})

describe('Pro-unavailable handling', () => {
  it('Pro unavailable when escalation needed → stop (escalation-model-unavailable)', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A, {
      proModelAvailable: false,
    }))
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') {
      expect(decision.reason).toBe('escalation-model-unavailable')
    }
  })

  it('Pro unavailable when Flash exhausted → stop (escalation-model-unavailable)', () => {
    const attempts = [
      makeAttempt(1, FLASH, false, { failureFingerprint: FP_B, progress: 'none' }),
      makeAttempt(2, FLASH, false, { failureFingerprint: FP_A, progress: 'partial' }),
      makeAttempt(3, FLASH, false, { failureFingerprint: FP_A, progress: 'none' }),
    ]
    const decision = decideRepair(makeInput(attempts, FAIL_A, {
      proModelAvailable: false,
    }))
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') {
      expect(decision.reason).toBe('escalation-model-unavailable')
    }
  })
})

describe('computeFailurePackageId', () => {
  it('produces a deterministic 16-hex-char ID', () => {
    const id = computeFailurePackageId('session-1', 1, 'rd-1')
    expect(id).toHaveLength(16)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('same inputs produce same ID', () => {
    const id1 = computeFailurePackageId('session-1', 1, 'rd-1')
    const id2 = computeFailurePackageId('session-1', 1, 'rd-1')
    expect(id1).toBe(id2)
  })

  it('different routing decision produces different ID', () => {
    const id1 = computeFailurePackageId('session-1', 1, 'rd-1')
    const id2 = computeFailurePackageId('session-1', 1, 'rd-2')
    expect(id1).not.toBe(id2)
  })
})

describe('computeProgressMetrics', () => {
  it('same failure → jaccard 1, no new/resolved', () => {
    const m = computeProgressMetrics(FAIL_A, FAIL_A)
    expect(m.jaccard).toBe(1)
    expect(m.newFailureCount).toBe(0)
    expect(m.resolvedFailureCount).toBe(0)
  })

  it('fewer failures → resolved > 0, new = 0', () => {
    const m = computeProgressMetrics(FAIL_B, FAIL_A)
    expect(m.resolvedFailureCount).toBeGreaterThan(0)
    expect(m.newFailureCount).toBe(0)
    expect(m.currentFailureCount).toBeLessThan(m.priorFailureCount)
  })

  it('more failures → new > 0, resolved = 0', () => {
    const m = computeProgressMetrics(FAIL_A, FAIL_B)
    expect(m.newFailureCount).toBeGreaterThan(0)
    expect(m.resolvedFailureCount).toBe(0)
    expect(m.currentFailureCount).toBeGreaterThan(m.priorFailureCount)
  })

  it('stores prior and current counts', () => {
    const m = computeProgressMetrics(FAIL_A, FAIL_B)
    expect(m.priorFailureCount).toBe(2)
    expect(m.currentFailureCount).toBe(4)
  })
})
