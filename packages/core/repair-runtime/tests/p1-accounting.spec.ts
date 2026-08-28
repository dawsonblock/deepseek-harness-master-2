/**
 * P1.1 canonical usage accounting tests. Verifies that real cost and latency
 * from `model/usage` events flow into `RepairAttempt.costUsd`,
 * `RepairState.totalCostUsd`, and `repair/completed.totalCostUsd`.
 *
 * Also verifies that `reconstructRepairState` recovers real cost from
 * durable usage events after restart.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-accounting.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_REPAIR_LIMITS, decideRepair } from '@deepseek-ai/dsh-repair-controller'
import type { GoalVerificationCheck } from '@deepseek-ai/dsh-goal'
import type { ModelRef } from '@deepseek-ai/dsh-repair-controller'
import type { ModelPricing } from '@deepseek-ai/dsh-token-meter'
import {
  type RepairHandlerDeps,
  type RepairState,
  computeAttemptAccounting,
  computeRepairId,
  handleVerificationFailure,
  handleVerificationPass,
  reconstructRepairState,
} from '../src/index.ts'

const FLASH: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const PRO: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

/** Flat pricing registry for tests — no time-banded entries. */
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
  session: Session,
  rdId: string,
  turn: number,
  model: ModelRef,
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

function appendVerification(session: Session, goalId: string, passed: boolean, checks: readonly GoalVerificationCheck[]): void {
  session.append('goal/verification', {
    goal: { id: goalId, revision: 1 },
    passed,
    checks,
  } as never, { ignorable: true })
}

/** Expected cost for given tokens under the test pricing registry. */
function expectedCost(model: ModelRef, tokens: { input: number; output: number; cacheRead: number; cacheMiss: number }): number {
  const pricing = TEST_PRICING.find(p => p.provider === model.provider && p.model === model.model)!
  const cacheHitCost = (tokens.cacheRead / 1_000_000) * pricing.perMillion.cacheHitInput
  const cacheMissCost = (tokens.cacheMiss / 1_000_000) * pricing.perMillion.cacheMissInput
  const outputCost = (tokens.output / 1_000_000) * pricing.perMillion.output
  return cacheHitCost + cacheMissCost + outputCost
}

describe('P1.1: computeAttemptAccounting', () => {
  it('computes cost and latency from model/usage event matching routingDecisionId', () => {
    const session = Session.create(SessionId('acct-helper'))
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })

    const { costUsd, latencyMs } = computeAttemptAccounting(session.events, 'rd-1', TEST_PRICING)

    const expected = expectedCost(FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    expect(costUsd).toBeCloseTo(expected, 10)
    expect(latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns zero cost when no model/usage event exists', () => {
    const session = Session.create(SessionId('acct-no-usage'))
    setupTurn(session, 1, FLASH, 'rd-1')
    // No model/usage event appended

    const { costUsd, latencyMs } = computeAttemptAccounting(session.events, 'rd-1', TEST_PRICING)

    expect(costUsd).toBe(0)
    expect(latencyMs).toBe(0)
  })

  it('returns zero cost when pricing registry has no matching entry', () => {
    const session = Session.create(SessionId('acct-no-pricing'))
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })

    // Empty pricing registry
    const { costUsd } = computeAttemptAccounting(session.events, 'rd-1', [])

    expect(costUsd).toBe(0)
  })
})

describe('P1.1: handleVerificationFailure populates real cost', () => {
  it('attempt.costUsd reflects model/usage event cost', () => {
    const session = Session.create(SessionId('acct-fail'))
    const goalId = 'goal-acct-fail'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    setupTurn(session, 1, FLASH, 'rd-1')
    const tokens = { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 }
    appendUsage(session, 'rd-1', 1, FLASH, tokens)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))

    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('flash-repair')
    const attempt = state.attempts[0]!
    const expected = expectedCost(FLASH, tokens)
    expect(attempt.costUsd).toBeCloseTo(expected, 10)
    expect(attempt.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('state.totalCostUsd accumulates across attempts', () => {
    const session = Session.create(SessionId('acct-accum'))
    const goalId = 'goal-acct-accum'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    const tokens1 = { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 }
    appendUsage(session, 'rd-1', 1, FLASH, tokens1)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const cost1 = expectedCost(FLASH, tokens1)
    expect(state.totalCostUsd).toBeCloseTo(cost1, 10)

    // Turn 2: Flash fails again (same failure → pro-escalate)
    setupTurn(session, 2, FLASH, 'rd-2')
    const tokens2 = { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 }
    appendUsage(session, 'rd-2', 2, FLASH, tokens2)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    const cost2 = expectedCost(FLASH, tokens2)
    expect(state.totalCostUsd).toBeCloseTo(cost1 + cost2, 10)
  })
})

describe('P1.1: repair/completed carries real totalCostUsd', () => {
  it('Flash fail → Flash repair pass → completed.totalCostUsd = sum of all attempt costs', async () => {
    const session = Session.create(SessionId('acct-completed'))
    const goalId = 'goal-acct-completed'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    const tokens1 = { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 }
    appendUsage(session, 'rd-1', 1, FLASH, tokens1)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash repair passes
    setupTurn(session, 2, FLASH, 'rd-2')
    const tokens2 = { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 }
    appendUsage(session, 'rd-2', 2, FLASH, tokens2)
    appendVerification(session, goalId, true, passChecks())
    await handleVerificationPass(session, state, 2, 'rd-2', TEST_PRICING)

    const completedEvent = session.events.find(e => e.type === 'repair/completed')
    expect(completedEvent).toBeDefined()
    const completedData = completedEvent!.data as { totalCostUsd: number; verified: boolean }
    expect(completedData.verified).toBe(true)

    const expectedTotal = expectedCost(FLASH, tokens1) + expectedCost(FLASH, tokens2)
    expect(completedData.totalCostUsd).toBeCloseTo(expectedTotal, 10)
  })
})

describe('P1.1: reconstructRepairState recovers real cost after restart', () => {
  it('reconstructed state has real totalCostUsd from model/usage events', () => {
    const session = Session.create(SessionId('acct-replay'))
    const goalId = 'goal-acct-replay'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')

    // Flash #1 fail
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    session.append('repair/evidence', {
      repairId, turn: 1, step: 0, attempt: 1, routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1', failurePackageId: 'fpid-1', progress: 'none',
      failedCriteria: ['criterion-1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session.append('repair/decision', {
      repairId, turn: 1, step: 0, attempt: 1, action: 'flash-repair', failureFingerprint: 'fp-1',
    }, { ignorable: true })

    // Flash #2 fail (same)
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    session.append('repair/evidence', {
      repairId, turn: 2, step: 0, attempt: 2, routingDecisionId: 'rd-2',
      failureFingerprint: 'fp-1', failurePackageId: 'fpid-2', progress: 'none',
      failedCriteria: ['criterion-1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session.append('repair/decision', {
      repairId, turn: 2, step: 0, attempt: 2, action: 'pro-escalate',
      reason: 'same-failure-no-progress', failureFingerprint: 'fp-1',
    }, { ignorable: true })

    // CRASH → restart → reconstruct
    const reconstructed = reconstructRepairState(session.events, goalId, TEST_PRICING)
    expect(reconstructed).toBeDefined()

    const expectedCost1 = expectedCost(FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    const expectedCost2 = expectedCost(FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })

    expect(reconstructed!.attempts[0]!.costUsd).toBeCloseTo(expectedCost1, 10)
    expect(reconstructed!.attempts[1]!.costUsd).toBeCloseTo(expectedCost2, 10)
    expect(reconstructed!.totalCostUsd).toBeCloseTo(expectedCost1 + expectedCost2, 10)
  })

  it('reconstructed cost matches live cost (deterministic accounting)', () => {
    const goalId = 'goal-acct-deterministic'
    const sessionId = SessionId('acct-deterministic')
    const repairId = computeRepairId(sessionId, goalId, 1, 'rd-1')
    const deps = defaultDeps()

    // Live execution
    const session1 = Session.create(sessionId)
    const state1 = freshState(repairId)

    setupTurn(session1, 1, FLASH, 'rd-1')
    appendUsage(session1, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session1, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session1, state1, deps, 1, failChecks(['criterion-1']))

    setupTurn(session1, 2, FLASH, 'rd-2')
    appendUsage(session1, 'rd-2', 2, FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })
    appendVerification(session1, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session1, state1, deps, 2, failChecks(['criterion-1']))

    const liveTotalCost = state1.totalCostUsd

    // Restart: reconstruct from durable events
    const session2 = Session.create(SessionId('acct-deterministic-restart'))
    setupTurn(session2, 1, FLASH, 'rd-1')
    appendUsage(session2, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session2, goalId, false, failChecks(['criterion-1']))
    session2.append('repair/evidence', {
      repairId, turn: 1, step: 0, attempt: 1, routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1', failurePackageId: 'fpid-1', progress: 'none',
      failedCriteria: ['criterion-1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session2.append('repair/decision', {
      repairId, turn: 1, step: 0, attempt: 1, action: 'flash-repair', failureFingerprint: 'fp-1',
    }, { ignorable: true })

    setupTurn(session2, 2, FLASH, 'rd-2')
    appendUsage(session2, 'rd-2', 2, FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })
    appendVerification(session2, goalId, false, failChecks(['criterion-1']))
    session2.append('repair/evidence', {
      repairId, turn: 2, step: 0, attempt: 2, routingDecisionId: 'rd-2',
      failureFingerprint: 'fp-1', failurePackageId: 'fpid-2', progress: 'none',
      failedCriteria: ['criterion-1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session2.append('repair/decision', {
      repairId, turn: 2, step: 0, attempt: 2, action: 'pro-escalate',
      reason: 'same-failure-no-progress', failureFingerprint: 'fp-1',
    }, { ignorable: true })

    const reconstructed = reconstructRepairState(session2.events, goalId, TEST_PRICING)
    expect(reconstructed).toBeDefined()

    // The reconstructed total cost must match the live total cost
    expect(reconstructed!.totalCostUsd).toBeCloseTo(liveTotalCost, 10)
  })
})

describe('P1.1: cost budget gate is reachable with real cost', () => {
  it('cost exceeding maxTaskCostUsd triggers stop(cost-limit) instead of flash-repair', () => {
    const session = Session.create(SessionId('acct-budget'))
    const goalId = 'goal-acct-budget'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)

    // Set a very low cost limit — 1 cent
    const deps = defaultDeps({
      limits: {
        maxFlashAttempts: 3,
        maxProAttempts: 2,
        maxTotalAttempts: 5,
        maxTaskCostUsd: 0.01,
      },
    })

    // Turn 1: Flash fails with enough tokens to exceed the 1-cent budget
    setupTurn(session, 1, FLASH, 'rd-1')
    // 100K cache-miss input tokens at $0.14/M = $0.014 — already exceeds $0.01
    appendUsage(session, 'rd-1', 1, FLASH, { input: 100000, output: 0, cacheRead: 0, cacheMiss: 100000 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // The cost ($0.014) exceeds the budget ($0.01), so the controller
    // should stop with cost-limit, not flash-repair.
    expect(result.action).toBe('stop')
    expect(result.reason).toBe('cost-limit')
  })
})
