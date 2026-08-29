/**
 * P1.14 terminal outcome semantics tests. Verifies that every
 * `repair/completed` event carries an explicit `outcome` field and that
 * consumers can determine the terminal state without inferring from
 * optional field combinations.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-outcome-semantics.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { decideRepair, type RepairLimits } from '@deepseek-ai/dsh-repair-controller'
import type { GoalVerificationCheck } from '@deepseek-ai/dsh-goal'
import type { ModelRef } from '@deepseek-ai/dsh-repair-controller'
import type { ModelPricing } from '@deepseek-ai/dsh-token-meter'
import {
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
    limits: {
      maxFlashAttempts: 3,
      maxProAttempts: 2,
      maxTotalAttempts: 5,
    },
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

function getCompletedOutcome(session: Session): string | undefined {
  const completed = session.events.filter(e => e.type === 'repair/completed')
  if (completed.length === 0) return undefined
  return (completed[completed.length - 1]!.data as { outcome?: string }).outcome
}

describe('P1.14: verified outcome on diagnostic pass', () => {
  it('handleVerificationPass returns outcome=verified', async () => {
    const session = Session.create(SessionId('outcome-verified'))
    const goalId = 'goal-outcome-verified'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    const result = await handleVerificationPass(session, state, 2, 'rd-2', TEST_PRICING)

    expect(result.outcome).toBe('verified')
  })
})

describe('P1.14: qualification-failed outcome on holdout failure', () => {
  it('handleVerificationPass with holdout failure returns outcome=qualification-failed', async () => {
    const session = Session.create(SessionId('outcome-qual-failed'))
    const goalId = 'goal-outcome-qual-failed'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    const result = await handleVerificationPass(session, state, 2, 'rd-2', TEST_PRICING, async () => ({
      passed: false,
      reason: 'holdout test failed',
    }), goalId)

    expect(result.outcome).toBe('qualification-failed')
  })
})

describe('P1.14: attempts-exhausted outcome', () => {
  it('stop with attempt-limit emits outcome=attempts-exhausted', () => {
    const session = Session.create(SessionId('outcome-exhausted'))
    const goalId = 'goal-outcome-exhausted'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const limits: RepairLimits = {
      maxFlashAttempts: 1,
      maxProAttempts: 1,
      maxTotalAttempts: 1,
    }
    const deps = defaultDeps({ limits })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(getCompletedOutcome(session)).toBe('attempts-exhausted')
  })
})

describe('P1.14: cost-limit outcome', () => {
  it('stop with cost-limit emits outcome=cost-limit', () => {
    const session = Session.create(SessionId('outcome-cost-limit'))
    const goalId = 'goal-outcome-cost-limit'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const limits: RepairLimits = {
      maxFlashAttempts: 3,
      maxProAttempts: 2,
      maxTotalAttempts: 5,
      maxTaskCostUsd: 0.001,
    }
    const deps = defaultDeps({ limits })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 10000, output: 5000, cacheRead: 2000, cacheMiss: 8000 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(getCompletedOutcome(session)).toBe('cost-limit')
  })
})

describe('P1.14: time-limit outcome', () => {
  it('stop with time-limit emits outcome=time-limit', () => {
    const session = Session.create(SessionId('outcome-time-limit'))
    const goalId = 'goal-outcome-time-limit'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    state.startedAt = Date.now() - 100000 // 100 seconds ago
    const limits: RepairLimits = {
      maxFlashAttempts: 3,
      maxProAttempts: 2,
      maxTotalAttempts: 5,
      maxElapsedMs: 1000, // 1 second
    }
    const deps = defaultDeps({ limits })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(getCompletedOutcome(session)).toBe('time-limit')
  })
})

describe('P1.14: output-token-limit outcome', () => {
  it('stop with output-token-limit emits outcome=output-token-limit', () => {
    const session = Session.create(SessionId('outcome-token-limit'))
    const goalId = 'goal-outcome-token-limit'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const limits: RepairLimits = {
      maxFlashAttempts: 3,
      maxProAttempts: 2,
      maxTotalAttempts: 5,
      maxOutputTokens: 100,
    }
    const deps = defaultDeps({ limits })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(getCompletedOutcome(session)).toBe('output-token-limit')
  })
})

describe('P1.14: model-unavailable outcome', () => {
  it('stop with escalation-model-unavailable emits outcome=model-unavailable', () => {
    const session = Session.create(SessionId('outcome-model-unavailable'))
    const goalId = 'goal-outcome-model-unavailable'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ proModelAvailable: false })

    // Two same-failure Flash attempts → would escalate, but Pro unavailable
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    expect(getCompletedOutcome(session)).toBe('model-unavailable')
  })
})

describe('P1.14: rollback-failed outcome', () => {
  it('rollback failure emits outcome=rollback-failed', () => {
    const session = Session.create(SessionId('outcome-rollback-failed'))
    const goalId = 'goal-outcome-rollback-failed'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({
      rollbackProvider: () => ({ success: false, rollbackTarget: 'ckpt-1', failureReason: 'not found' }),
    })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(getCompletedOutcome(session)).toBe('rollback-failed')
  })
})

describe('P1.14: every completed event has an outcome', () => {
  it('all repair/completed events in a session have a non-undefined outcome', () => {
    const session = Session.create(SessionId('outcome-all'))
    const goalId = 'goal-outcome-all'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const limits: RepairLimits = {
      maxFlashAttempts: 1,
      maxProAttempts: 1,
      maxTotalAttempts: 1,
    }
    const deps = defaultDeps({ limits })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const completedEvents = session.events.filter(e => e.type === 'repair/completed')
    expect(completedEvents.length).toBe(1)
    const data = completedEvents[0]!.data as { outcome?: string }
    expect(data.outcome).toBeDefined()
    expect(typeof data.outcome).toBe('string')
  })
})
