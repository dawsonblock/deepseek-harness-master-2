/**
 * Deterministic runtime tests for the repair controller's pure decision
 * logic. Eight scenarios cover the full v0.18 verified-escalation policy.
 *
 * @module @deepseek-ai/dsh-repair-controller/tests/decide.spec
 */

import { describe, expect, it } from 'vitest'
import { decideRepair, computeFailureFingerprint, classifyProgress } from '../src/decide.ts'
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
    budget: { totalCostUsd: attempts.length * 0.01, elapsedMs: attempts.length * 1000 },
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
