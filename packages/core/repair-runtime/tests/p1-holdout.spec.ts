/**
 * P1.3 diagnostic/holdout runtime separation tests. Verifies that:
 *
 * 1. Diagnostic verification failure triggers repair (existing behavior).
 * 2. Diagnostic verification pass with no holdout verifier → normal completion.
 * 3. Diagnostic verification pass + holdout pass → normal completion (verified=true).
 * 4. Diagnostic verification pass + holdout fail → qualification failure
 *    (verified=false, qualificationFailure present, NO repair triggered).
 * 5. Holdout failure evidence does NOT appear as repair evidence.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-holdout.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_REPAIR_LIMITS, decideRepair } from '@deepseek-ai/dsh-repair-controller'
import type { GoalVerificationCheck } from '@deepseek-ai/dsh-goal'
import type { ModelRef } from '@deepseek-ai/dsh-repair-controller'
import type { ModelPricing } from '@deepseek-ai/dsh-token-meter'
import {
  type HoldoutVerifier,
  type RepairHandlerDeps,
  type RepairState,
  computeRepairId,
  handleVerificationFailure,
  handleVerificationPass,
} from '../src/index.ts'

const FLASH: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const PRO: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

const TEST_PRICING: readonly ModelPricing[] = Object.freeze([
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    currency: 'USD',
    version: 'test-flash',
    observedAt: '2026-08-27',
    perMillion: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'USD',
    version: 'test-pro',
    observedAt: '2026-08-27',
    perMillion: { cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
  },
])

function failChecks(criteria: string[]): readonly GoalVerificationCheck[] {
  return criteria.map(c => ({ name: 'acceptance', role: 'acceptance', passed: false, reason: c, evidence: [] }))
}

function passChecks(): readonly GoalVerificationCheck[] {
  return [{ name: 'acceptance', role: 'acceptance', passed: true, reason: '', evidence: [] }]
}

function defaultDeps(overrides: Partial<RepairHandlerDeps> = {}): RepairHandlerDeps {
  return {
    flashModel: FLASH,
    proModel: PRO,
    limits: DEFAULT_REPAIR_LIMITS,
    decide: decideRepair,
    proModelAvailable: true,
    manualModelSelection: false,
    pricingRegistry: TEST_PRICING,
    ...overrides,
  }
}

function freshState(repairId: string): RepairState {
  return {
    repairId,
    attempts: [],
    totalCostUsd: 0,
    elapsedMs: 0,
    startedAt: Date.now(),
    flashAttempts: 0,
    proAttempts: 0,
    totalOutputTokens: 0,
  }
}

function setupTurn(session: Session, turn: number, model: ModelRef, rdId: string): void {
  session.append('turn/start', { turn }, { ignorable: true })
  session.append('model/routing-decision', {
    routingDecisionId: rdId,
    turn,
    step: 1,
    proposed: { provider: model.provider, model: model.model },
    selected: { provider: model.provider, model: model.model },
    authority: 'router',
    activeAuthority: 'router',
    reason: 'routed-fast',
    authorityEpoch: turn,
  } as never, { ignorable: true })
}

function appendUsage(
  session: Session, rdId: string, turn: number, model: ModelRef,
  tokens: { input: number; output: number; cacheRead: number; cacheMiss: number },
): void {
  session.append('model/usage', {
    turn, step: 0, attempt: turn,
    provider: model.provider, model: model.model,
    routingDecisionId: rdId,
    usage: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheMissTokens: tokens.cacheMiss,
      totalTokens: tokens.input + tokens.output + tokens.cacheRead,
      source: 'provider',
    },
  }, { ignorable: true })
}

function appendVerification(
  session: Session, goalId: string, passed: boolean,
  checks: readonly GoalVerificationCheck[],
): void {
  session.append('goal/verification', {
    goal: { id: goalId, revision: 1 },
    passed,
    checks,
  } as never, { ignorable: true })
}

describe('P1.3: diagnostic failure triggers repair (baseline)', () => {
  it('diagnostic FAIL → repair/evidence + repair/decision, no holdout', () => {
    const session = Session.create(SessionId('holdout-baseline'))
    const goalId = 'goal-holdout-baseline'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('flash-repair')
    expect(state.attempts.length).toBe(1)

    // repair/evidence should contain the diagnostic failure
    const evidenceEvents = session.events.filter(e => e.type === 'repair/evidence')
    expect(evidenceEvents.length).toBe(1)
    const evidenceData = evidenceEvents[0]!.data as { failedCriteria: readonly string[] }
    expect(evidenceData.failedCriteria).toContain('criterion-1')
  })
})

describe('P1.3: diagnostic pass with no holdout → normal completion', () => {
  it('diagnostic PASS + no holdoutVerifier → repair/completed verified=true', async () => {
    const session = Session.create(SessionId('holdout-none'))
    const goalId = 'goal-holdout-none'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash repair passes (no holdout verifier)
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    await handleVerificationPass(session, state, 2, 'rd-2', TEST_PRICING)

    const completedEvent = session.events.find(e => e.type === 'repair/completed')
    expect(completedEvent).toBeDefined()
    const data = completedEvent!.data as { verified: boolean; qualificationFailure?: unknown }
    expect(data.verified).toBe(true)
    expect(data.qualificationFailure).toBeUndefined()
  })
})

describe('P1.3: diagnostic pass + holdout pass → normal completion', () => {
  it('diagnostic PASS + holdout PASS → repair/completed verified=true', async () => {
    const session = Session.create(SessionId('holdout-pass'))
    const goalId = 'goal-holdout-pass'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    const holdoutPass: HoldoutVerifier = () => ({
      passed: true,
      reason: 'holdout verification passed',
    })

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash repair passes + holdout passes
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    await handleVerificationPass(
      session, state, 2, 'rd-2', TEST_PRICING, holdoutPass, goalId,
    )

    const completedEvent = session.events.find(e => e.type === 'repair/completed')
    expect(completedEvent).toBeDefined()
    const data = completedEvent!.data as { verified: boolean; qualificationFailure?: unknown }
    expect(data.verified).toBe(true)
    expect(data.qualificationFailure).toBeUndefined()
  })
})

describe('P1.3: diagnostic pass + holdout fail → qualification failure, no repair', () => {
  it('diagnostic PASS + holdout FAIL → repair/completed verified=false with qualificationFailure', async () => {
    const session = Session.create(SessionId('holdout-fail'))
    const goalId = 'goal-holdout-fail'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    const holdoutFail: HoldoutVerifier = () => ({
      passed: false,
      reason: 'holdout: integration test coverage below threshold',
      evidence: ['coverage: 45%', 'threshold: 80%'],
    })

    // Turn 1: Flash fails (diagnostic)
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    await handleVerificationPass(
      session, state, 2, 'rd-2', TEST_PRICING, holdoutFail, goalId,
    )

    const completedEvent = session.events.find(e => e.type === 'repair/completed')
    expect(completedEvent).toBeDefined()
    const data = completedEvent!.data as {
      verified: boolean
      qualificationFailure?: { reason: string; evidence?: readonly string[] }
    }
    expect(data.verified).toBe(false)
    expect(data.qualificationFailure).toBeDefined()
    expect(data.qualificationFailure!.reason).toBe('holdout: integration test coverage below threshold')
    expect(data.qualificationFailure!.evidence).toEqual(['coverage: 45%', 'threshold: 80%'])
  })

  it('holdout failure does NOT produce repair evidence for the passing attempt', async () => {
    const session = Session.create(SessionId('holdout-no-evidence'))
    const goalId = 'goal-holdout-no-evidence'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    const holdoutFail: HoldoutVerifier = () => ({
      passed: false,
      reason: 'holdout failed',
    })

    // Turn 1: Flash fails (diagnostic) → produces repair/evidence
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const evidenceBeforeHoldout = session.events.filter(e => e.type === 'repair/evidence').length

    // Turn 2: Flash repair passes diagnostic, holdout fails
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    await handleVerificationPass(
      session, state, 2, 'rd-2', TEST_PRICING, holdoutFail, goalId,
    )

    // The holdout failure must NOT produce additional repair/evidence
    const evidenceAfterHoldout = session.events.filter(e => e.type === 'repair/evidence').length
    expect(evidenceAfterHoldout).toBe(evidenceBeforeHoldout)

    // The holdout failure must NOT produce a repair/decision
    const decisionEvents = session.events.filter(e => e.type === 'repair/decision')
    // Only the one from Turn 1 (flash-repair), none from the holdout failure
    expect(decisionEvents.length).toBe(1)
  })

  it('holdout failure does NOT trigger another repair attempt', async () => {
    const session = Session.create(SessionId('holdout-no-repair'))
    const goalId = 'goal-holdout-no-repair'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    const holdoutFail: HoldoutVerifier = () => ({
      passed: false,
      reason: 'holdout failed',
    })

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const attemptsBeforeHoldout = state.attempts.length

    // Turn 2: diagnostic passes, holdout fails
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    await handleVerificationPass(
      session, state, 2, 'rd-2', TEST_PRICING, holdoutFail, goalId,
    )

    // No new attempt should be added for the holdout failure
    expect(state.attempts.length).toBe(attemptsBeforeHoldout)

    // Exactly one repair/completed (the holdout failure completion)
    const completedEvents = session.events.filter(e => e.type === 'repair/completed')
    expect(completedEvents.length).toBe(1)
  })
})

describe('P1.3: async holdout verifier', () => {
  it('async holdout verifier is awaited', async () => {
    const session = Session.create(SessionId('holdout-async'))
    const goalId = 'goal-holdout-async'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    const asyncHoldout: HoldoutVerifier = async () => {
      // Simulate async work
      await Promise.resolve()
      return { passed: false, reason: 'async holdout failed' }
    }

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: diagnostic passes, async holdout fails
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    const completedEvent = await handleVerificationPass(
      session, state, 2, 'rd-2', TEST_PRICING, asyncHoldout, goalId,
    )

    expect(completedEvent).toBeDefined()
    const data = completedEvent!.data as {
      verified: boolean
      qualificationFailure?: { reason: string }
    }
    expect(data.verified).toBe(false)
    expect(data.qualificationFailure).toBeDefined()
    expect(data.qualificationFailure!.reason).toBe('async holdout failed')
  })
})
